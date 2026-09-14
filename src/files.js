import { snakeToPascal, pascalToSnake } from './utils.js';

// Load JSON file in Pilot2 format
export function importLevelFromJson(jsonData, blocksByPaletteId, blocksById) {
  if (typeof jsonData === 'string') {
    jsonData = JSON.parse(jsonData);
  }

  const version = jsonData.Version || 20;
  const width = jsonData.Width || 100;
  const height = jsonData.Height || 100;
  
  // Parse Meta Settings
  let meta = { title: 'Untitled World', backgroundColor: 0xFF0b0f19 };
  if (jsonData.Meta && jsonData.Meta.WorldSettings) {
    try {
      const settings = JSON.parse(jsonData.Meta.WorldSettings);
      meta = {
        title: settings.title || 'Untitled World',
        backgroundColor: settings.backgroundColor || 0xFF0b0f19,
        voidColor: settings.voidColor || 0xFF000000,
        minimapEnabled: settings.minimapEnabled !== false
      };
    } catch (e) {
      console.warn('Could not parse WorldSettings metadata:', e);
    }
  }

  // Create empty grids
  const bgGrid = Array.from({ length: width }, () => Array.from({ length: height }, () => ({ id: 0, fields: {} })));
  const fgGrid = Array.from({ length: width }, () => Array.from({ length: height }, () => ({ id: 0, fields: {} })));
  const olGrid = Array.from({ length: width }, () => Array.from({ length: height }, () => ({ id: 0, fields: {} })));
  
  const layers = [bgGrid, fgGrid, olGrid];

  // Load Palette
  const blockPallet = jsonData.BlockPallet || [];
  const palette = blockPallet.map(pItem => {
    // pItem has Name (PascalCase or snake_case) and Fields
    const pName = pItem.Name;
    
    // Find matching block metadata
    let blockMeta = blocksByPaletteId.get(pName);
    if (!blockMeta) {
      // Try snake_case conversion
      const snakeName = pascalToSnake(pName);
      blockMeta = blocksByPaletteId.get(snakeName);
    }

    return {
      id: blockMeta ? blockMeta.Id : 0,
      fields: pItem.Fields || {}
    };
  });

  // Load Placed Blocks
  const blockReferences = jsonData.BlockReferences || [];
  blockReferences.forEach(ref => {
    // ref is [layer, x, y, palletIndex]
    const [layer, x, y, palletIndex] = ref;
    if (x >= 0 && x < width && y >= 0 && y < height && layer >= 0 && layer < 3) {
      const palletBlock = palette[palletIndex];
      if (palletBlock) {
        layers[layer][x][y] = {
          id: palletBlock.id,
          fields: { ...palletBlock.fields }
        };
      }
    }
  });

  // Load Labels with full ProtoTextLabel properties
  const labels = (jsonData.Labels || []).map(lbl => {
    const rawPos = lbl.position || { x: lbl.x || 0, y: lbl.y || 0 };
    let px = rawPos.x;
    let py = rawPos.y;
    if (px < width && py < height && !lbl.position) {
      px = px * 16;
      py = py * 16;
    }
    return {
      id: lbl.id,
      x: px,
      y: py,
      text: lbl.text || '',
      color: lbl.color !== undefined ? lbl.color : 0xFFFFFFFF,
      maxWidth: lbl.maxWidth || lbl.max_width,
      shadow: lbl.shadow || false,
      textAlignment: lbl.textAlignment !== undefined ? lbl.textAlignment : (lbl.text_alignment !== undefined ? lbl.text_alignment : 0),
      fontSize: lbl.fontSize !== undefined ? lbl.fontSize : (lbl.font_size || 12),
      characterSpacing: lbl.characterSpacing !== undefined ? lbl.characterSpacing : (lbl.character_spacing || 0),
      lineSpacing: lbl.lineSpacing !== undefined ? lbl.lineSpacing : (lbl.line_spacing || 0),
      renderLayer: lbl.renderLayer !== undefined ? lbl.renderLayer : (lbl.render_layer !== undefined ? lbl.render_layer : 1),
      shadowColor: lbl.shadowColor !== undefined ? lbl.shadowColor : (lbl.shadow_color !== undefined ? lbl.shadow_color : 0xFF000000),
      shadowOffsetX: lbl.shadowOffsetX !== undefined ? lbl.shadowOffsetX : (lbl.shadow_offset_x !== undefined ? lbl.shadow_offset_x : 1),
      shadowOffsetY: lbl.shadowOffsetY !== undefined ? lbl.shadowOffsetY : (lbl.shadow_offset_y !== undefined ? lbl.shadow_offset_y : 1),
      outline: lbl.outline || false,
      outlineColor: lbl.outlineColor !== undefined ? lbl.outlineColor : (lbl.outline_color !== undefined ? lbl.outline_color : 0xFF000000),
      outlineWidth: lbl.outlineWidth !== undefined ? lbl.outlineWidth : (lbl.outline_width !== undefined ? lbl.outline_width : 1)
    };
  });

  // Ensure border on Layer 1 is filled if empty
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
        if (layers[1][x][y].id === 0) {
          layers[1][x][y] = { id: 283, fields: {} }; // Basic Gray border fallback
        }
      }
    }
  }

  return {
    width,
    height,
    meta,
    layers,
    labels
  };
}

// Export Level to JSON string in Pilot2 format
export function exportLevelToJson(editorState, blocksById) {
  const { width, height, meta, layers, labels } = editorState;

  const saveData = {
    Version: 20,
    Width: width,
    Height: height,
    Meta: {
      WorldSettings: JSON.stringify({
        title: meta.title || 'Untitled World',
        backgroundColor: meta.backgroundColor || 4280821800,
        voidColor: meta.voidColor || 4280821800,
        minimapEnabled: meta.minimapEnabled !== false
      })
    },
    BlocksVersion: 1,
    Labels: labels.map(lbl => ({
      id: lbl.id,
      position: { x: lbl.x, y: lbl.y },
      text: lbl.text,
      color: lbl.color,
      fontSize: lbl.fontSize,
      textAlignment: lbl.textAlignment,
      shadow: lbl.shadow,
      shadowColor: lbl.shadowColor,
      shadowOffsetX: lbl.shadowOffsetX,
      shadowOffsetY: lbl.shadowOffsetY,
      outline: lbl.outline,
      outlineColor: lbl.outlineColor,
      outlineWidth: lbl.outlineWidth
    })),
    BlockPallet: [],
    BlockReferences: []
  };

  const paletteMap = new Map(); // key -> index
  const getBlockKey = (block) => `${block.id}:${JSON.stringify(block.fields || {})}`;

  // Helper to add block to pallet
  const getPalletIndex = (block) => {
    const key = getBlockKey(block);
    if (paletteMap.has(key)) return paletteMap.get(key);

    const index = saveData.BlockPallet.length;
    paletteMap.set(key, index);

    // Retrieve C# Enum Name for block (PascalCase)
    const blockMeta = blocksById.get(block.id);
    let blockName = 'Empty';
    if (blockMeta) {
      blockName = snakeToPascal(blockMeta.PaletteId);
    }

    saveData.BlockPallet.push({
      Name: blockName,
      Fields: block.fields || {}
    });

    return index;
  };

  // Traverse grid and store non-empty blocks
  for (let l = 0; l < 3; l++) {
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        const block = layers[l][x][y];
        if (block && block.id !== 0) {
          const pIndex = getPalletIndex(block);
          saveData.BlockReferences.push([l, x, y, pIndex]);
        }
      }
    }
  }

  return JSON.stringify(saveData, null, 2);
}
