import protobuf from 'protobufjs';
import { fetchJoinKey } from './api.js';

let root = null;
let WorldPacket = null;

export async function initProtocol() {
  if (root) return;
  try {
    const response = await fetch('/world.proto');
    if (!response.ok) throw new Error('Failed to fetch world.proto');
    const protoText = await response.text();
    
    const parsed = protobuf.parse(protoText);
    root = parsed.root;
    WorldPacket = root.lookupType('WorldPackets.WorldPacket');
  } catch (err) {
    console.error('Error initializing protobuf protocol:', err);
    throw err;
  }
}

// 7-bit Varint Helpers
function readVarint(bytes, offsetObj) {
  let result = 0;
  let shift = 0;
  while (true) {
    if (offsetObj.offset >= bytes.length) {
      throw new Error("Unexpected end of byte array while reading varint");
    }
    const byte = bytes[offsetObj.offset++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return result;
}

function writeVarint(value, bytesList) {
  while (value >= 0x80) {
    bytesList.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytesList.push(value & 0x7f);
}

// Field values helper
function decodeFieldValue(protoVal) {
  if (!protoVal) return null;
  
  // 1. If it's a protobufjs oneof message, read the active field name from the "value" property
  if (protoVal.value && protoVal[protoVal.value] !== undefined) {
    return protoVal[protoVal.value];
  }

  // 2. Fallback for plain objects: check key existence in own properties
  const keys = Object.keys(protoVal);
  if (keys.includes('int32Value')) return protoVal.int32Value;
  if (keys.includes('uint32Value')) return protoVal.uint32Value;
  if (keys.includes('stringValue')) return protoVal.stringValue;
  if (keys.includes('boolValue')) return protoVal.boolValue;
  if (keys.includes('byteArrayValue')) return protoVal.byteArrayValue;

  if (keys.includes('int32_value')) return protoVal.int32_value;
  if (keys.includes('uint32_value')) return protoVal.uint32_value;
  if (keys.includes('string_value')) return protoVal.string_value;
  if (keys.includes('bool_value')) return protoVal.bool_value;
  if (keys.includes('byte_array_value')) return protoVal.byte_array_value;

  // 3. Fallback: check defined value fields
  if (protoVal.int32Value !== undefined && protoVal.int32Value !== null) return protoVal.int32Value;
  if (protoVal.uint32Value !== undefined && protoVal.uint32Value !== null) return protoVal.uint32Value;
  if (protoVal.stringValue !== undefined && protoVal.stringValue !== null) return protoVal.stringValue;
  if (protoVal.boolValue !== undefined && protoVal.boolValue !== null) return protoVal.boolValue;
  if (protoVal.byteArrayValue !== undefined && protoVal.byteArrayValue !== null) return protoVal.byteArrayValue;

  if (protoVal.int32_value !== undefined && protoVal.int32_value !== null) return protoVal.int32_value;
  if (protoVal.uint32_value !== undefined && protoVal.uint32_value !== null) return protoVal.uint32_value;
  if (protoVal.string_value !== undefined && protoVal.string_value !== null) return protoVal.string_value;
  if (protoVal.bool_value !== undefined && protoVal.bool_value !== null) return protoVal.bool_value;
  if (protoVal.byte_array_value !== undefined && protoVal.byte_array_value !== null) return protoVal.byte_array_value;

  return null;
}

// Mapping of block field names to their respective schema types in PixelWalker
const FIELD_TYPES = {
  // UInt32 fields
  color: 'UInt32',
  start_color: 'UInt32',
  fade_to_color: 'UInt32',
  
  // Int32 fields
  coins: 'Int32',
  time: 'Int32',
  offset: 'Int32',
  percentage: 'Int32',
  duration: 'Int32',
  jumps: 'Int32',
  switch_id: 'Int32',
  deaths: 'Int32',
  value: 'Int32',
  shape: 'Int32',
  size_max: 'Int32',
  
  // Boolean fields
  hide_clock: 'Boolean',
  enabled: 'Boolean',
  
  // String fields
  spawn_id: 'String',
  text: 'String',
  portal_id: 'String',
  target_id: 'String',
  target: 'String',
  
  // ByteArray fields
  notes: 'ByteArray'
};

function encodeFieldValue(key, value) {
  const type = FIELD_TYPES[key];

  if (type === 'UInt32') {
    let uintVal = typeof value === 'number' ? value : parseInt(value, 10);
    if (isNaN(uintVal)) uintVal = 0;
    return {
      uint32Value: uintVal,
      uint32_value: uintVal
    };
  }

  if (type === 'Int32') {
    let intVal = typeof value === 'number' ? value : parseInt(value, 10);
    if (isNaN(intVal)) intVal = 0;
    return {
      int32Value: intVal,
      int32_value: intVal
    };
  }

  if (type === 'Boolean') {
    const boolVal = value === true || value === 'true';
    return {
      boolValue: boolVal,
      bool_value: boolVal
    };
  }

  if (type === 'String') {
    const strVal = value !== null && value !== undefined ? String(value) : '';
    return {
      stringValue: strVal,
      string_value: strVal
    };
  }

  if (type === 'ByteArray') {
    let bytes = value;
    if (typeof value === 'string') {
      bytes = new TextEncoder().encode(value);
    } else if (!(value instanceof Uint8Array)) {
      bytes = new Uint8Array(value || []);
    }
    return {
      byteArrayValue: bytes,
      byte_array_value: bytes
    };
  }

  // Fallback: check JavaScript variable types
  if (typeof value === 'number') {
    return {
      int32Value: value,
      int32_value: value
    };
  }
  if (typeof value === 'boolean') {
    return {
      boolValue: value,
      bool_value: value
    };
  }
  if (typeof value === 'string') {
    return {
      stringValue: value,
      string_value: value
    };
  }
  if (value instanceof Uint8Array) {
    return {
      byteArrayValue: value,
      byte_array_value: value
    };
  }
  return {};
}

// Decode Layer bytes (RLE column-major)
export function decodeRleLayer(width, height, bytes, palette) {
  const grid = Array.from({ length: width }, () =>
    Array.from({ length: height }, () => ({ id: 0, fields: {} }))
  );

  if (!bytes || bytes.length === 0) {
    return grid;
  }

  const offsetObj = { offset: 0 };
  let i = 0;
  const totalCells = width * height;

  while (i < totalCells && offsetObj.offset < bytes.length) {
    const palletId = readVarint(bytes, offsetObj);
    const amount = readVarint(bytes, offsetObj);

    const block = palette[palletId] || { blockId: 0, fields: {} };

    for (let d = 0; d < amount; d++) {
      if (i >= totalCells) break;
      const x = Math.floor(i / height);
      const y = i % height;
      grid[x][y] = {
        id: block.blockId,
        fields: { ...block.fields }
      };
      i++;
    }
  }

  return grid;
}

// Encode Layer to RLE bytes
export function encodeRleLayer(width, height, grid, paletteMap, paletteList) {
  const bytes = [];
  let currentBlockKey = null;
  let currentPalletId = null;
  let runLength = 0;

  const getBlockKey = (block) => {
    return `${block.id}:${JSON.stringify(block.fields || {})}`;
  };

  const getPalletId = (block) => {
    const key = getBlockKey(block);
    if (paletteMap.has(key)) {
      return paletteMap.get(key);
    }
    const idx = paletteList.length;
    paletteMap.set(key, idx);
    
    const protoFields = {};
    if (block.fields) {
      for (const [fName, fVal] of Object.entries(block.fields)) {
        protoFields[fName] = encodeFieldValue(fName, fVal);
      }
    }
    
    paletteList.push({
      blockId: block.id,
      fields: protoFields
    });
    return idx;
  };

  for (let i = 0; i < width * height; i++) {
    const x = Math.floor(i / height);
    const y = i % height;
    const block = grid[x][y] || { id: 0, fields: {} };

    const blockKey = getBlockKey(block);
    const palletId = getPalletId(block);

    if (currentBlockKey === null) {
      currentBlockKey = blockKey;
      currentPalletId = palletId;
      runLength = 1;
    } else if (currentBlockKey === blockKey) {
      runLength++;
    } else {
      writeVarint(currentPalletId, bytes);
      writeVarint(runLength, bytes);
      currentBlockKey = blockKey;
      currentPalletId = palletId;
      runLength = 1;
    }
  }

  if (runLength > 0) {
    writeVarint(currentPalletId, bytes);
    writeVarint(runLength, bytes);
  }

  return new Uint8Array(bytes);
}

// Import World State from Live Room via WS
export async function importWorldFromLive(roomId, token = null, onStatusChange = () => {}) {
  await initProtocol();
  onStatusChange('Retrieving join key...');
  const joinKey = await fetchJoinKey(roomId, token);
  
  return new Promise((resolve, reject) => {
    let finished = false;

    const safeReject = (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(connectionTimeout);
      reject(err);
    };

    const safeResolve = (val) => {
      if (finished) return;
      finished = true;
      clearTimeout(connectionTimeout);
      resolve(val);
    };

    onStatusChange('Connecting to WebSocket server...');
    const wsUrl = `wss://server.pixelwalker.net/ws?joinKey=${joinKey}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    let connectionTimeout = setTimeout(() => {
      ws.close();
      safeReject(new Error('Connection timed out waiting for level data.'));
    }, 15000);

    ws.onopen = () => {
      onStatusChange('Connected. Waiting for world initial state...');
    };

    ws.onmessage = async (event) => {
      try {
        const bytes = new Uint8Array(event.data);
        const decoded = WorldPacket.decode(bytes);
        
        if (decoded.ping) {
          const pingAck = WorldPacket.create({ ping: {} });
          ws.send(WorldPacket.encode(pingAck).finish());
          return;
        }

        if (decoded.playerInitPacket) {
          onStatusChange('World data received. Decoding layers...');
          const init = decoded.playerInitPacket;
          
          // Parse Palette
          const rawPalette = init.blockDataPalette || [];
          const palette = rawPalette.map(item => {
            const fields = {};
            if (item.fields) {
              for (const [key, val] of Object.entries(item.fields)) {
                fields[key] = decodeFieldValue(val);
              }
            }
            return {
              blockId: item.blockId,
              fields
            };
          });

          // Decode layers
          const width = init.worldWidth;
          const height = init.worldHeight;
          const bgGrid = decodeRleLayer(width, height, init.backgroundLayerData, palette);
          const fgGrid = decodeRleLayer(width, height, init.foregroundLayerData, palette);
          const olGrid = decodeRleLayer(width, height, init.overlayLayerData, palette);
          
          // Decode Text Labels with full ProtoTextLabel properties
          const labels = (init.textLabels || []).map(label => ({
            id: label.id,
            x: label.position ? label.position.x : 0,
            y: label.position ? label.position.y : 0,
            text: label.text || '',
            color: label.color !== undefined ? label.color : 0xFFFFFFFF,
            maxWidth: label.maxWidth,
            shadow: label.shadow || false,
            textAlignment: label.textAlignment !== undefined ? label.textAlignment : 0,
            fontSize: label.fontSize || 12,
            characterSpacing: label.characterSpacing || 0,
            lineSpacing: label.lineSpacing || 0,
            renderLayer: label.renderLayer !== undefined ? label.renderLayer : 1,
            shadowColor: label.shadowColor !== undefined ? label.shadowColor : 0xFF000000,
            shadowOffsetX: label.shadowOffsetX !== undefined ? label.shadowOffsetX : 1,
            shadowOffsetY: label.shadowOffsetY !== undefined ? label.shadowOffsetY : 1,
            outline: label.outline || false,
            outlineColor: label.outlineColor !== undefined ? label.outlineColor : 0xFF000000,
            outlineWidth: label.outlineWidth !== undefined ? label.outlineWidth : 1
          }));

          // Send init received pack
          const ack = WorldPacket.create({ playerInitReceived: {} });
          ws.send(WorldPacket.encode(ack).finish());

          onStatusChange('Disconnecting cleanly...');
          ws.close();
          
          safeResolve({
            width,
            height,
            meta: init.worldMeta,
            layers: [bgGrid, fgGrid, olGrid],
            labels
          });
        }
      } catch (err) {
        ws.close();
        safeReject(err);
      }
    };

    ws.onerror = (err) => {
      safeReject(new Error('WebSocket connection error.'));
    };

    ws.onclose = () => {
      safeReject(new Error('Connection closed by server.'));
    };
  });
}

// Export World State to Live Room via WS (diff updates)
export async function exportWorldToLive(roomId, token, editorState, onStatusChange = () => {}, onProgress = () => {}, secretCode = null) {
  await initProtocol();
  onStatusChange('Retrieving join key for write access...');
  const joinKey = await fetchJoinKey(roomId, token);

  return new Promise((resolve, reject) => {
    let finished = false;

    const safeReject = (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(connectionTimeout);
      reject(err);
    };

    const safeResolve = (val) => {
      if (finished) return;
      finished = true;
      clearTimeout(connectionTimeout);
      resolve(val);
    };

    onStatusChange('Connecting to server...');
    const wsUrl = `wss://server.pixelwalker.net/ws?joinKey=${joinKey}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    let hasReceivedInit = false;
    let initPacketCached = null;
    let diffQueue = [];
    let sentCount = 0;
    let totalCount = 0;

    let connectionTimeout = setTimeout(() => {
      ws.close();
      safeReject(new Error('Connection timed out waiting for write clearance.'));
    }, 15000);

    ws.onopen = () => {
      onStatusChange('Connected. Authenticating...');
    };

    ws.onmessage = async (event) => {
      try {
        const bytes = new Uint8Array(event.data);
        const decoded = WorldPacket.decode(bytes);

        if (decoded.ping) {
          const pingAck = WorldPacket.create({ ping: {} });
          ws.send(WorldPacket.encode(pingAck).finish());
          return;
        }

        if (decoded.playerInitPacket) {
          clearTimeout(connectionTimeout);
          hasReceivedInit = true;
          initPacketCached = decoded.playerInitPacket;
          const init = initPacketCached;

          // Acknowledge Init
          const ack = WorldPacket.create({ playerInitReceived: {} });
          ws.send(WorldPacket.encode(ack).finish());

          // Verify Edit Rights
          if (!init.playerProperties?.rights?.canEdit) {
            if (secretCode) {
              onStatusChange('World is write-protected. Authenticating with secret code...');
              const codePacket = WorldPacket.create({
                playerEnterSecretEditKeyPacket: {
                  secretEditKey: secretCode
                }
              });
              ws.send(WorldPacket.encode(codePacket).finish());
              
              // Set a timeout to reject if auth fails or we don't get the rights packet
              connectionTimeout = setTimeout(() => {
                ws.close();
                safeReject(new Error('Incorrect secret edit code or rights authentication timeout.'));
              }, 5000);
            } else {
              ws.close();
              return safeReject(new Error('You do not have Edit Rights in this world. Provide a secret edit code.'));
            }
          } else {
            // Already have edit rights, proceed
            startDiffSync(init);
          }
        } else if (decoded.playerUpdateRightsPacket && !diffQueue.length && hasReceivedInit) {
          const update = decoded.playerUpdateRightsPacket;
          if (update.rights?.canEdit) {
            clearTimeout(connectionTimeout);
            onStatusChange('Secret code accepted. Edit rights acquired!');
            startDiffSync(initPacketCached);
          } else {
            ws.close();
            return safeReject(new Error('Incorrect secret edit code or insufficient rights.'));
          }
        }
      } catch (err) {
        ws.close();
        safeReject(err);
      }
    };

    function startDiffSync(init) {
      onStatusChange('Connected. Comparing level buffers...');
      
      // Parse server layers to compute differences
      const rawPalette = init.blockDataPalette || [];
      const serverPalette = rawPalette.map(item => {
        const fields = {};
        if (item.fields) {
          for (const [key, val] of Object.entries(item.fields)) {
            fields[key] = decodeFieldValue(val);
          }
        }
        return { blockId: item.blockId, fields };
      });

      const width = init.worldWidth;
      const height = init.worldHeight;
      const serverLayers = [
        decodeRleLayer(width, height, init.backgroundLayerData, serverPalette),
        decodeRleLayer(width, height, init.foregroundLayerData, serverPalette),
        decodeRleLayer(width, height, init.overlayLayerData, serverPalette)
      ];

      // Compute Diffs
      for (let layer = 0; layer < 3; layer++) {
        for (let x = 0; x < Math.min(width, editorState.width); x++) {
          for (let y = 0; y < Math.min(height, editorState.height); y++) {
            const sBlock = serverLayers[layer][x][y];
            const eBlock = editorState.layers[layer][x][y];
            
            // Compare block ID and fields
            const match = sBlock.id === eBlock.id && JSON.stringify(sBlock.fields) === JSON.stringify(eBlock.fields);
            if (!match) {
              diffQueue.push({
                x, y, layer,
                id: eBlock.id,
                fields: eBlock.fields
              });
            }
          }
        }
      }

      totalCount = diffQueue.length;
      onStatusChange(`Syncing level... ${totalCount} blocks to place.`);
      
      if (totalCount === 0) {
        onStatusChange('No changes detected. Sync complete.');
        ws.close();
        return safeResolve();
      }

      // Start sending blocks in rate-limited chunks
      sendNextChunk();
    }

    function sendNextChunk() {
      if (diffQueue.length === 0) {
        onStatusChange('Export sync complete! Saving changes...');
        // PixelWalker autosaves, but we trigger a manual disconnect
        setTimeout(() => {
          ws.close();
          safeResolve();
        }, 1000);
        return;
      }

      // Group identical blocks to use positions array if possible, 
      // or send single/multiple WorldBlockPlaced packets.
      // Chunk size: 50 blocks.
      const chunkSize = Math.min(diffQueue.length, 50);
      const chunk = diffQueue.splice(0, chunkSize);
      
      // Send blocks in chunk
      chunk.forEach(diff => {
        const protoFields = {};
        if (diff.fields) {
          for (const [fName, fVal] of Object.entries(diff.fields)) {
            protoFields[fName] = encodeFieldValue(fName, fVal);
          }
        }

        const placement = WorldPacket.create({
          worldBlockPlacedPacket: {
            positions: [{ x: diff.x, y: diff.y }],
            layer: diff.layer,
            blockId: diff.id,
            fields: protoFields
          }
        });
        
        ws.send(WorldPacket.encode(placement).finish());
        sentCount++;
      });

      onProgress(sentCount, totalCount);
      // Wait 100ms between chunks to avoid server overload/rate limit kick
      setTimeout(sendNextChunk, 100);
    }

    ws.onerror = (err) => {
      safeReject(new Error('WebSocket connection error during sync.'));
    };

    ws.onclose = () => {
      if (hasReceivedInit && sentCount < totalCount) {
        safeReject(new Error('WebSocket closed prematurely during synchronization.'));
      } else {
        safeReject(new Error('Connection closed by server.'));
      }
    };
  });
}
