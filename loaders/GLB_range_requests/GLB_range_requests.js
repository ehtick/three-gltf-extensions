import {
  FileLoader,
  LoaderUtils
} from 'three';

const loadPartially = (fileLoader, url, offset, length) => {
  return new Promise((resolve, reject) => {
    const currentRequestHeader = fileLoader.requestHeader;
    fileLoader.setRequestHeader(Object.assign(
      {Range: `bytes=${offset}-${offset + length - 1}`},
      currentRequestHeader
    ));
    // Note: If server doesn't support HTTP range requests
    //       reject callback is fired.
    fileLoader.load(url, resolve, undefined, reject);
    fileLoader.setRequestHeader(currentRequestHeader);
  });
};

// GLB File Format handlers
// Specification: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#glb-file-format-specification

const BINARY_HEADER_MAGIC = 'glTF';
const BINARY_HEADER_LENGTH = 12;
const BINARY_CHUNK_TYPES = {JSON: 0x4E4F534A, BIN: 0x004E4942};

export default class GLBRangeRequests {
  constructor(parser, url, binChunkOffset) {
    this.name = 'GLB_range_requests';
    this.parser = parser;
    this.url = url;
    this.binChunkOffset = binChunkOffset;
  }

  static load(url, loader, onLoad, onProgress, onError, fileLoader = null) {
    const assetUrl = (loader.path || '') + url;
    GLBRangeRequests.loadContent(assetUrl, fileLoader).then(content => {
      let resourcePath;
      if (loader.resourcePath !== '') {
        resourcePath = loader.resourcePath;
      } else if (loader.path !== '') {
        resourcePath = loader.path;
      } else {
        resourcePath = LoaderUtils.extractUrlBase(assetUrl);
      }

      loader
        .register(parser => new GLBRangeRequests(
          parser,
          assetUrl,
          content.binChunkOffset
        ))
        .parse(content.jsonContent, resourcePath, onLoad, onError);
    }).catch((error) => {
      // Perhaps rejected due to the either one
      // 1. The asset is not GLB (but glTF)
      // 2. Server may not support HTTP range requests
      // 3. The asset includes EXT_meshopt_compression extension that the
      //    this plugin can't handle
      // so load in the regular way as fallback.
      // @TODO: Check the error reason and don't run the fallback loading
      //        if the error reason is others?

      // console.log(error);
      loader.load(url, onLoad, onProgress, onError);
    });
  }

  // Note: Rejects if server doesn't support HTTP range requests
  static async loadContent(url, fileLoader = null) {
    if (fileLoader === null) {
      fileLoader = new FileLoader().setResponseType('arraybuffer');
    }

    // Load the GLB header and the first chunk info
    const buffer = await loadPartially(fileLoader, url, 0, BINARY_HEADER_LENGTH + 8);
    const view = new DataView(buffer);
    const header = {
      magic: LoaderUtils.decodeText(new Uint8Array(buffer.slice(0, 4))),
      version: view.getUint32(4, true),
      length: view.getUint32(8, true)
    };

    if (header.magic !== BINARY_HEADER_MAGIC) {
      return Promise.reject(new Error('GLBRangeRequests: The file is not GLB.'));
    }

    if (header.version < 2.0) {
      return Promise.reject(new Error('GLBRangeRequests: Legacy binary file detected.'));
    }

    const firstChunkLength = view.getUint32(12, true);
    const firstChunkType = view.getUint32(16, true);

    const result = {
      jsonContent: null,
      binChunkOffset: null
    };

    let offset = BINARY_HEADER_LENGTH + 8;

    if (firstChunkType === BINARY_CHUNK_TYPES.JSON) {
      result.jsonContent = await loadPartially(fileLoader, url, offset, firstChunkLength);
    } else if (firstChunkType === BINARY_CHUNK_TYPES.BIN) {
      result.binChunkOffset = offset;
    }

    offset += firstChunkLength;

    // The number of json chunks must be 1. The number of bin chunks must be 0 or 1.
    // So, if the second chunk exists the second chunk can be guessed from the first
    // chunk type.
    // Note: Assuming the GLB format is valid
    if (offset < header.length) {
      if (result.jsonContent === null) {
        const buffer = await loadPartially(fileLoader, url, offset, 4);
        const view = new DataView(buffer);
        const length = view.getUint32(0, true);
        result.jsonContent = await loadPartially(fileLoader, url, offset + 8, length);
      } else {
        result.binChunkOffset = offset + 8;
      }
    }

    if (result.jsonContent.extensionsUsed &&
        result.jsonContent.extensionsUsed.indexOf('EXT_meshopt_compression') >= 0) {
      return Promise.reject(new Error('GLBRangeRequests: currently no EXT_meshopt_compression extension support.'));
    }

    return result;
  }

  loadBufferView(bufferViewIndex) {
    const parser = this.parser;
    const json = parser.json;

    const bufferViewDef = json.bufferViews[bufferViewIndex];
    const bufferIndex = bufferViewDef.buffer;
    const bufferDef = json.buffers[bufferIndex];

    if (bufferDef.type !== undefined && bufferDef.type !== 'arraybuffer') {
      return null;
    }

    if (bufferDef.uri !== undefined || bufferIndex !== 0) {
      return null;
    }

    const fileLoader = parser.fileLoader;
    const length = bufferViewDef.byteLength || 0;
    const offset = bufferViewDef.byteOffset || 0;

    return loadPartially(fileLoader, this.url, this.binChunkOffset + offset, length);
  }
}
