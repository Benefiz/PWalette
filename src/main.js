import { initProtocol, importWorldFromLive, exportWorldToLive } from './protocol.js';
import { loginWithPassword, fetchWorlds } from './api.js';

import { PixelEditor } from './editor.js';
import { argbToRgba, snakeToPascal, argbToHex, hexToArgb } from './utils.js';
import { initAssets, getBlockSpriteStyle, findAtlasFrame } from './assets.js';

// Global variables
let editor = null;
let blocksData = [];
let authToken = localStorage.getItem('pw_auth_token') || null;
let authRecord = null;

// Decodes a JWT token base64 payload to read Pocketbase user record fields
function decodeJwt(token) {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    return JSON.parse(jsonPayload);
  } catch (e) {
    return null;
  }
}

function parseAuthToken(token) {
  const payload = decodeJwt(token);
  if (!payload) return null;
  const record = payload.model || payload;
  return {
    id: record.id || '',
    username: record.username || record.email || 'Token Authenticated',
    role: record.role || 'Player'
  };
}

// Initialize the Application
async function initApp() {
  const canvas = document.getElementById('editor-canvas');
  const container = document.getElementById('canvas-container');
  
  // Create editor status message log helper
  const showStatus = (msg) => {
    console.log(msg);
    document.getElementById('block-hover-display').textContent = msg;
  };

  editor = new PixelEditor(canvas, container, showStatus);

  // Bind Ctrl+Click / Alt+Click / Inspect tool callback
  editor.onBlockInspected = (block, x, y, layer) => {
    if (!block || block.id === 0) return;
    const bMeta = editor.blocksById.get(block.id);
    if (!bMeta) return;

    editor.activeBlock = {
      id: block.id,
      fields: { ...block.fields }
    };
    editor.activeEditingCoordinate = { x, y, layer };

    // Determine the category of the block
    let category = 'blocks';
    const pId = bMeta.PaletteId.toLowerCase();

    // backgrounds on Layer 0
    const isBackground = bMeta.Layer === 0;

    // interactive actions
    const isAction = !pId.startsWith('fog_') && (
      pId.startsWith('hazard_') || pId.includes('spike') ||
      pId.startsWith('climbable_') ||
      pId.startsWith('liquid_') || (bMeta.Layer === 2 && !pId.startsWith('border_')) ||
      pId.startsWith('portal_') || pId.startsWith('tool_portal_') ||
      pId.startsWith('switch_') ||
      pId.startsWith('note_') ||
      pId.startsWith('boost_') || pId.startsWith('weak_boost_') ||
      pId.startsWith('coin_') ||
      pId.endsWith('_gate') || pId.endsWith('_door') ||
      pId.startsWith('counter_') ||
      pId.startsWith('crown_') ||
      pId.startsWith('effect_') || pId.startsWith('effects_') ||
      pId.startsWith('gravity_') || pId.startsWith('invisible_gravity_') ||
      pId.startsWith('key_') ||
      pId.startsWith('sign_') || pId.startsWith('special_') ||
      pId.startsWith('team_') || pId.startsWith('tool_') ||
      pId.includes('firework')
    );

    // atlas-defined decorations
    const frameInfo = findAtlasFrame(bMeta.PaletteId, bMeta.Layer);
    const isDecorative = pId.startsWith('fog_') || !!(frameInfo && frameInfo.filename && (
      frameInfo.filename.toLowerCase().startsWith('decoration/') ||
      frameInfo.filename.toLowerCase().startsWith('decorative/')
    ));

    if (isBackground) category = 'backgrounds';
    else if (isAction) category = 'actions';
    else if (isDecorative) category = 'decoratives';
    else category = 'blocks';

    // Switch active tab UI
    const tabs = document.querySelectorAll('.category-tab');
    tabs.forEach(tab => {
      if (tab.dataset.cat === category) {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
      }
    });

    // Render the palette for that category
    renderBlockPalette(category);

    // Find the item in the newly rendered grid, highlight and scroll into view
    const items = document.querySelectorAll('.palette-item');
    items.forEach(el => {
      if (parseInt(el.dataset.id, 10) === block.id) {
        el.classList.add('active');
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } else {
        el.classList.remove('active');
      }
    });

    // Render properties editor populated with block fields
    renderBlockPropertiesEditor(bMeta, true);
  };

  // Minimap x2 toggle click handler
  const minimapPanel = document.getElementById('minimap-panel');
  if (minimapPanel) {
    minimapPanel.addEventListener('click', () => {
      minimapPanel.classList.toggle('x2');
      if (editor) {
        editor.updateMinimap();
      }
    });
  }

  // Load world.proto in parallel
  initProtocol().catch(e => console.error("Protobuf compilation failed:", e));

  // Fetch block palette mappings
  try {
    const res = await fetch('/blocks.json');
    if (!res.ok) throw new Error('Failed to load blocks.json');
    blocksData = await res.json();
    editor.setBlocksDatabase(blocksData);
    
    // Load block spritesheet in parallel with stale-while-revalidate background update support
    initAssets(() => {
      console.log('Block sprites atlas updated from network. Re-drawing canvas and block palette...');
      if (editor) {
        editor.draw();
      }
      const activeTab = document.querySelector('.category-tab.active');
      renderBlockPalette(activeTab ? activeTab.dataset.cat : 'all');
    }).then(success => {
      if (success) {
        console.log('Block sprites atlas loaded. Re-drawing canvas and block palette...');
        editor.draw();
        renderBlockPalette('all');
      }
    });

    // Setup block grid UI
    renderBlockPalette('all');
    setupPaletteCategoryTabs();
  } catch (err) {
    showStatus('Error loading block library metadata.');
    console.error(err);
  }

  // Setup UI Hooks
  setupToolboxHooks();
  setupLayersHooks();
  setupViewOptionHooks();
  setupAuthAndSyncHooks();
  setupHeaderActionHooks();
  setupCollapsiblePanels();
  setupHotbar();
  setupLabelInspectorModal();

  // Try auto-login if token exists
  if (authToken) {
    try {
      const savedUser = localStorage.getItem('pw_user_record');
      if (savedUser) {
        authRecord = JSON.parse(savedUser);
      } else {
        authRecord = parseAuthToken(authToken) || { id: '', username: 'Token Authenticated', role: 'Player' };
        localStorage.setItem('pw_user_record', JSON.stringify(authRecord));
      }
      onLoggedIn();
    } catch(e) {
      localStorage.removeItem('pw_auth_token');
      localStorage.removeItem('pw_user_record');
    }
  }

  // Initial draw
  editor.centerCamera();
  editor.draw();

  // Listen for window resize to maintain canvas centring
  window.addEventListener('resize', () => {
    editor.updateCanvasPosition();
    editor.draw();
  });

  // Global keyboard shortcuts (tools, arrow navigation, etc.)
  window.addEventListener('keydown', e => {
    // Prevent shortcuts when typing in inputs/textareas
    const activeEl = document.activeElement;
    if (activeEl && (
      activeEl.tagName === 'INPUT' || 
      activeEl.tagName === 'TEXTAREA' || 
      activeEl.tagName === 'SELECT' || 
      activeEl.isContentEditable
    )) {
      return;
    }

    const key = e.key.toLowerCase();
    
    // Tools shortcuts mapping
    const toolsMap = {
      'p': 'tool-pencil',
      'b': 'tool-brush',
      'f': 'tool-fill',
      't': 'tool-label',
      'r': 'tool-shape-rect',
      'c': 'tool-shape-circle',
      's': 'tool-select',
      'm': 'tool-move',
      'i': 'tool-inspect'
    };

    if (toolsMap[key]) {
      e.preventDefault();
      const btn = document.getElementById(toolsMap[key]);
      if (btn) btn.click();
      return;
    }

    // Arrow keys navigation/panning
    if (editor) {
      const step = editor.zoom * 2;
      if (key === 'arrowup') {
        e.preventDefault();
        editor.panY += step;
        editor.updateCanvasPosition();
        editor.draw();
      } else if (key === 'arrowdown') {
        e.preventDefault();
        editor.panY -= step;
        editor.updateCanvasPosition();
        editor.draw();
      } else if (key === 'arrowleft') {
        e.preventDefault();
        editor.panX += step;
        editor.updateCanvasPosition();
        editor.draw();
      } else if (key === 'arrowright') {
        e.preventDefault();
        editor.panX -= step;
        editor.updateCanvasPosition();
        editor.draw();
      }
    }
  });
}

// Render Block Palette Grid
function renderBlockPalette(category = 'all', searchQuery = '') {
  const grid = document.getElementById('palette-grid');
  grid.innerHTML = '';

  const query = searchQuery.toLowerCase().trim();

  // Filter blocks based on the new category mappings
  const filtered = blocksData.filter(b => {
    // Exclude database empty block (ID 0) to avoid duplicates
    if (b.Id === 0) return false;

    // Search match
    const nameMatch = b.PaletteId.toLowerCase().includes(query);
    if (query && !nameMatch) return false;

    if (category === 'all') return true;
    
    const pId = b.PaletteId.toLowerCase();

    // backgrounds on Layer 0
    const isBackground = b.Layer === 0;

    // interactive actions
    const isAction = !pId.startsWith('fog_') && (
      pId.startsWith('hazard_') || pId.includes('spike') ||
      pId.startsWith('climbable_') ||
      pId.startsWith('liquid_') || (b.Layer === 2 && !pId.startsWith('border_')) ||
      pId.startsWith('portal_') || pId.startsWith('tool_portal_') ||
      pId.startsWith('switch_') ||
      pId.startsWith('note_') ||
      pId.startsWith('boost_') || pId.startsWith('weak_boost_') ||
      pId.startsWith('coin_') ||
      pId.endsWith('_gate') || pId.endsWith('_door') ||
      pId.startsWith('counter_') ||
      pId.startsWith('crown_') ||
      pId.startsWith('effect_') || pId.startsWith('effects_') ||
      pId.startsWith('gravity_') || pId.startsWith('invisible_gravity_') ||
      pId.startsWith('key_') ||
      pId.startsWith('sign_') || pId.startsWith('special_') ||
      pId.startsWith('team_') || pId.startsWith('tool_') ||
      pId.includes('firework')
    );

    // atlas-defined decorations
    const frameInfo = findAtlasFrame(b.PaletteId, b.Layer);
    const isDecorative = pId.startsWith('fog_') || !!(frameInfo && frameInfo.filename && (
      frameInfo.filename.toLowerCase().startsWith('decoration/') ||
      frameInfo.filename.toLowerCase().startsWith('decorative/')
    ));

    // blocks tab handles all solid and non-action blocks that are not atlas-labeled decorations
    const isSolid = b.Layer !== 0 && !isAction && !isDecorative;

    if (category === 'blocks') return isSolid;
    if (category === 'backgrounds') return isBackground;
    if (category === 'actions') return isAction;
    if (category === 'decoratives') return isDecorative;

    return false;
  });

  // Sort by Id ascending (0 to 1617)
  filtered.sort((a, b) => a.Id - b.Id);

  // Prepend virtual Empty Block (ID: 0) if category matches all/blocks and query is empty/matching
  const showEmpty = (category === 'all' || category === 'blocks') && 
                     (!query || 'empty'.includes(query) || 'air'.includes(query) || 'eraser'.includes(query));
  
  if (showEmpty) {
    filtered.unshift({
      Id: 0,
      PaletteId: 'empty_block',
      Layer: 1,
      MinimapColor: 0
    });
  }

  filtered.forEach(b => {
    const item = document.createElement('div');
    item.className = 'palette-item';
    item.dataset.id = b.Id;
    item.draggable = true;

    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', JSON.stringify(b));
      e.dataTransfer.effectAllowed = 'copy';
    });

    if (editor.activeBlock.id === b.Id) {
      item.classList.add('active');
    }
    item.title = `${b.PaletteId} (Layer ${b.Layer})`;

    // Block visual indicator
    const icon = document.createElement('div');
    icon.className = 'palette-item-icon';
    
    if (b.Id === 0) {
      icon.className = 'palette-item-icon empty-eraser';
      icon.innerHTML = '⌧';
    } else {
      const spriteStyle = getBlockSpriteStyle(b.PaletteId, b.Layer, 32);
      if (spriteStyle) {
        Object.assign(icon.style, spriteStyle);
      } else {
        icon.style.backgroundColor = b.MinimapColor ? argbToRgba(b.MinimapColor) : '#475569';
        
        // Fallback text overlays if assets aren't loaded yet
        if (b.PaletteId.startsWith('sign_')) {
          icon.innerHTML = '<span style="font-size:8px;color:#000;font-weight:bold;display:flex;align-items:center;justify-content:center;height:100%;">S</span>';
          icon.style.backgroundColor = '#fff';
        } else if (b.PaletteId.startsWith('portal_')) {
          icon.innerHTML = '<span style="font-size:8px;color:#fff;font-weight:bold;display:flex;align-items:center;justify-content:center;height:100%;">P</span>';
          icon.style.backgroundColor = '#7c3aed';
        } else if (b.PaletteId === 'portal_world') {
          icon.innerHTML = '<span style="font-size:8px;color:#fff;font-weight:bold;display:flex;align-items:center;justify-content:center;height:100%;">W</span>';
          icon.style.backgroundColor = '#06b6d4';
        } else if (b.PaletteId.startsWith('switch_')) {
          icon.innerHTML = '<span style="font-size:7px;color:#fff;font-weight:bold;display:flex;align-items:center;justify-content:center;height:100%;">SW</span>';
          icon.style.backgroundColor = '#1e3a8a';
        }
      }
    }

    item.appendChild(icon);

    item.addEventListener('click', () => {
      // Toggle active states in palette
      document.querySelectorAll('.palette-item').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      
      // Update editor active block
      editor.activeBlock = { id: b.Id, fields: {} };
      editor.activeEditingCoordinate = null; // Clear coordinate inspect state on picking new block

      // Switch layer tab contextually if auto route is enabled
      if (editor.autoRouteLayer) {
        const routeL = editor.getRouteLayer(b.Id);
        document.querySelectorAll('.layer-item').forEach(el => el.classList.remove('active'));
        document.querySelector(`.layer-item[data-layer="${routeL}"]`).classList.add('active');
        editor.activeLayer = routeL;
      }

      // Generate properties input forms
      renderBlockPropertiesEditor(b);
    });

    grid.appendChild(item);
  });
}

function setupPaletteCategoryTabs() {
  const tabs = document.querySelectorAll('.category-tab');
  const searchInput = document.getElementById('block-search');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderBlockPalette(tab.dataset.cat, searchInput.value);
    });
  });

  searchInput.addEventListener('input', () => {
    const activeTab = document.querySelector('.category-tab.active');
    renderBlockPalette(activeTab.dataset.cat, searchInput.value);
  });
}

// Generate input fields for special block arguments
function renderBlockPropertiesEditor(blockMeta, useExistingFields = false) {
  const container = document.getElementById('block-arg-editor');
  const fieldsContainer = document.getElementById('editor-fields-container');
  fieldsContainer.innerHTML = '';

  if (!blockMeta.Fields || blockMeta.Fields.length === 0) {
    container.style.display = 'none';
    editor.activeEditingCoordinate = null; // Reset placed block editing
    return;
  }

  container.style.display = 'block';

  blockMeta.Fields.forEach(field => {
    const group = document.createElement('div');
    group.className = 'input-group';
    
    const label = document.createElement('label');
    label.textContent = `${field.Name} (${field.Type})`;
    label.title = field.Description || '';
    
    let input = null;

    // Read current value
    let val = editor.activeBlock.fields[field.Name];
    if (val === undefined || !useExistingFields) {
      val = field.DefaultValue;
      if (val === undefined) {
        if (field.Type === 'Int32' || field.Type === 'UInt32') val = 0;
        else if (field.Type === 'String') val = '';
        else if (field.Type === 'Boolean') val = false;
      }
      editor.activeBlock.fields[field.Name] = val;
    }

    // Append description below the label if present
    const appendDescription = () => {
      group.appendChild(label);
      if (field.Description) {
        const desc = document.createElement('span');
        desc.className = 'field-desc';
        desc.style.color = 'var(--text-muted)';
        desc.style.fontSize = '10.5px';
        desc.style.display = 'block';
        desc.style.marginBottom = '6px';
        desc.style.lineHeight = '1.3';
        desc.textContent = field.Description;
        group.appendChild(desc);
      }
    };

    // Special case: Color Picker UI for 'color' fields
    if (field.Name === 'color') {
      input = document.createElement('input');
      input.type = 'color';
      input.value = argbToHex(val);
    } else if (field.Type === 'String') {
      if (field.Name === 'text') {
        input = document.createElement('textarea');
        input.rows = 3;
        input.value = val;
        input.placeholder = 'Enter sign text...';
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.value = val;
        input.placeholder = field.DefaultValue || '';
      }
    } else if (field.Type === 'Int32' || field.Type === 'UInt32') {
      input = document.createElement('input');
      input.type = 'number';
      input.value = val;
      if (field.MinValue !== undefined) input.min = field.MinValue;
      if (field.MaxValue !== undefined) input.max = field.MaxValue;
    } else if (field.Type === 'Boolean') {
      const checkboxLabel = document.createElement('label');
      checkboxLabel.className = 'checkbox-container';
      
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = val === true;
      
      const checkmark = document.createElement('span');
      checkmark.className = 'checkmark';
      
      checkboxLabel.appendChild(input);
      checkboxLabel.appendChild(checkmark);
      checkboxLabel.appendChild(document.createTextNode(` ${field.Name}`));
      
      appendDescription();
      group.appendChild(checkboxLabel);
      fieldsContainer.appendChild(group);

      // Bind check box listener
      input.addEventListener('change', () => {
        const checked = input.checked;
        editor.activeBlock.fields[field.Name] = checked;
        
        // If we are editing a placed block, update it in real-time on canvas
        if (editor.activeEditingCoordinate) {
          const { x, y, layer } = editor.activeEditingCoordinate;
          editor.layers[layer][x][y].fields[field.Name] = checked;
          editor.draw();
        }
      });
      return;
    }

    if (input) {
      appendDescription();
      group.appendChild(input);
      fieldsContainer.appendChild(group);      // Bind input listener with validation
      const updateHandler = () => {
        let inputVal = input.value;
        let isValid = true;
        let errorMsg = '';

        // 1. Check Required constraint
        if (field.Required) {
          if (inputVal === undefined || inputVal === null || inputVal.toString().trim() === '') {
            isValid = false;
            errorMsg = 'This field is required.';
          }
        }

        if (isValid) {
          if (field.Name === 'color') {
            // Color picker is always valid. Parse as 24-bit RGB if max is 16777215, otherwise 32-bit ARGB.
            if (field.MaxValue === 16777215) {
              const r = parseInt(inputVal.slice(1, 3), 16);
              const g = parseInt(inputVal.slice(3, 5), 16);
              const b = parseInt(inputVal.slice(5, 7), 16);
              inputVal = ((r << 16) | (g << 8) | b) >>> 0;
            } else {
              inputVal = hexToArgb(inputVal);
            }
          } else if (field.Type === 'Int32' || field.Type === 'UInt32') {
            const intVal = parseInt(inputVal, 10);
            if (isNaN(intVal)) {
              if (field.Required) {
                isValid = false;
                errorMsg = 'Must be a valid integer.';
              } else {
                inputVal = field.DefaultValue !== undefined ? field.DefaultValue : 0;
              }
            } else {
              if (field.MinValue !== undefined && intVal < field.MinValue) {
                isValid = false;
                errorMsg = `Value must be at least ${field.MinValue}.`;
              }
              if (field.MaxValue !== undefined && intVal > field.MaxValue) {
                isValid = false;
                errorMsg = `Value must be at most ${field.MaxValue}.`;
              }
              if (field.ExcludedValues && field.ExcludedValues.includes(intVal)) {
                isValid = false;
                errorMsg = `Value cannot be: ${field.ExcludedValues.join(', ')}`;
              }
            }
            if (isValid) {
              inputVal = intVal;
            }
          } else if (field.Type === 'String') {
            if (field.Pattern) {
              try {
                const regex = new RegExp(field.Pattern);
                if (!regex.test(inputVal)) {
                  isValid = false;
                  errorMsg = `Must match pattern: ${field.Pattern}`;
                }
              } catch (e) {
                console.error('Invalid regex pattern:', field.Pattern);
              }
            }
          }
        }

        // UI Feedback
        let errEl = group.querySelector('.field-error');
        if (!isValid) {
          input.classList.add('invalid-input');
          if (!errEl) {
            errEl = document.createElement('span');
            errEl.className = 'field-error';
            errEl.style.color = '#ef4444';
            errEl.style.fontSize = '10px';
            errEl.style.marginTop = '4px';
            errEl.style.display = 'block';
            group.appendChild(errEl);
          }
          errEl.textContent = errorMsg;
          return; // Do not apply invalid values to activeBlock or level data
        } else {
          input.classList.remove('invalid-input');
          if (errEl) errEl.remove();
        }

        editor.activeBlock.fields[field.Name] = inputVal;

        // If we are editing a placed block, update it in real-time on canvas
        if (editor.activeEditingCoordinate) {
          const { x, y, layer } = editor.activeEditingCoordinate;
          editor.layers[layer][x][y].fields[field.Name] = inputVal;
          if (field.Name === 'text') {
            const bFields = editor.layers[layer][x][y].fields;
            editor.updateTextLabel(x, y, {
              text: inputVal,
              color: bFields.color !== undefined ? bFields.color : 0xFFFFFFFF,
              fontSize: bFields.fontSize !== undefined ? bFields.fontSize : 12,
              textAlignment: bFields.textAlignment !== undefined ? bFields.textAlignment : 0,
              shadow: bFields.shadow || false,
              shadowColor: bFields.shadowColor !== undefined ? bFields.shadowColor : 0xFF000000,
              shadowOffsetX: bFields.shadowOffsetX !== undefined ? bFields.shadowOffsetX : 1,
              shadowOffsetY: bFields.shadowOffsetY !== undefined ? bFields.shadowOffsetY : 1,
              outline: bFields.outline || false,
              outlineColor: bFields.outlineColor !== undefined ? bFields.outlineColor : 0xFF000000,
              outlineWidth: bFields.outlineWidth !== undefined ? bFields.outlineWidth : 1
            });
          }
          editor.draw();
        }
      };

      input.addEventListener('input', updateHandler);
    }
  });

  // Render Label Formatting Section for Sign/Text blocks
  const hasTextField = blockMeta.Fields && blockMeta.Fields.some(f => f.Name === 'text');
  if (hasTextField) {
    const sectionHeader = document.createElement('div');
    sectionHeader.style.margin = '14px 0 8px 0';
    sectionHeader.style.paddingTop = '10px';
    sectionHeader.style.borderTop = '1px solid var(--border-color)';
    sectionHeader.style.fontSize = '11px';
    sectionHeader.style.fontWeight = '700';
    sectionHeader.style.textTransform = 'uppercase';
    sectionHeader.style.letterSpacing = '0.5px';
    sectionHeader.style.color = 'var(--color-primary)';
    sectionHeader.textContent = 'Label Formatting';
    fieldsContainer.appendChild(sectionHeader);

    let curFields = editor.activeBlock.fields;
    if (editor.activeEditingCoordinate) {
      const { x, y, layer } = editor.activeEditingCoordinate;
      curFields = editor.layers[layer][x][y].fields;
    }

    const syncLabelProps = (key, value) => {
      editor.activeBlock.fields[key] = value;
      if (editor.activeEditingCoordinate) {
        const { x, y, layer } = editor.activeEditingCoordinate;
        editor.layers[layer][x][y].fields[key] = value;
        const bFields = editor.layers[layer][x][y].fields;
        editor.updateTextLabel(x, y, {
          text: bFields.text || '',
          color: bFields.color !== undefined ? bFields.color : 0xFFFFFFFF,
          fontSize: bFields.fontSize !== undefined ? bFields.fontSize : 12,
          textAlignment: bFields.textAlignment !== undefined ? bFields.textAlignment : 0,
          renderLayer: bFields.renderLayer !== undefined ? bFields.renderLayer : 1,
          shadow: bFields.shadow || false,
          shadowColor: bFields.shadowColor !== undefined ? bFields.shadowColor : 0xFF000000,
          shadowOffsetX: bFields.shadowOffsetX !== undefined ? bFields.shadowOffsetX : 1,
          shadowOffsetY: bFields.shadowOffsetY !== undefined ? bFields.shadowOffsetY : 1,
          outline: bFields.outline || false,
          outlineColor: bFields.outlineColor !== undefined ? bFields.outlineColor : 0xFF000000,
          outlineWidth: bFields.outlineWidth !== undefined ? bFields.outlineWidth : 1
        });
        editor.draw();
      }
    };

    // 1. Text Color & Render Layer Row
    const topRowGroup = document.createElement('div');
    topRowGroup.className = 'form-row';
    topRowGroup.style.display = 'flex';
    topRowGroup.style.gap = '8px';

    const colorGroup = document.createElement('div');
    colorGroup.className = 'input-group';
    colorGroup.style.flex = '1';
    colorGroup.innerHTML = '<label>Text Color</label>';
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    const initialColor = (curFields.color !== undefined && curFields.color !== 0) ? curFields.color : 0xFFFFFFFF;
    colorInput.value = argbToHex(initialColor);
    colorInput.addEventListener('input', () => {
      syncLabelProps('color', hexToArgb(colorInput.value));
    });
    colorGroup.appendChild(colorInput);

    const layerGroup = document.createElement('div');
    layerGroup.className = 'input-group';
    layerGroup.style.flex = '1';
    layerGroup.innerHTML = '<label>Render Layer</label>';
    const layerSelect = document.createElement('select');
    layerSelect.className = 'select-dropdown';
    layerSelect.style.width = '100%';
    layerSelect.style.padding = '8px';
    layerSelect.style.borderRadius = '4px';
    layerSelect.style.background = 'var(--bg-card)';
    layerSelect.style.color = 'var(--text-color)';
    layerSelect.style.border = '1px solid var(--border-color)';
    layerSelect.innerHTML = `
      <option value="0">0: Above Background</option>
      <option value="1">1: Above Foreground</option>
      <option value="2">2: Above Player</option>
      <option value="3">3: Above Overlay</option>
    `;
    layerSelect.value = String(curFields.renderLayer !== undefined ? curFields.renderLayer : 1);
    layerSelect.addEventListener('change', () => {
      syncLabelProps('renderLayer', parseInt(layerSelect.value, 10));
    });
    layerGroup.appendChild(layerSelect);

    topRowGroup.appendChild(colorGroup);
    topRowGroup.appendChild(layerGroup);
    fieldsContainer.appendChild(topRowGroup);

    // 2. Font Size & Alignment Row
    const rowGroup = document.createElement('div');
    rowGroup.className = 'form-row';
    rowGroup.style.display = 'flex';
    rowGroup.style.gap = '8px';

    const sizeGroup = document.createElement('div');
    sizeGroup.className = 'input-group';
    sizeGroup.style.flex = '1';
    sizeGroup.innerHTML = '<label>Font Size (px)</label>';
    const sizeInput = document.createElement('input');
    sizeInput.type = 'number';
    sizeInput.min = 6;
    sizeInput.max = 72;
    sizeInput.value = curFields.fontSize !== undefined ? curFields.fontSize : 12;
    sizeInput.addEventListener('input', () => {
      const val = parseInt(sizeInput.value, 10) || 12;
      syncLabelProps('fontSize', val);
    });
    sizeGroup.appendChild(sizeInput);

    const alignGroup = document.createElement('div');
    alignGroup.className = 'input-group';
    alignGroup.style.flex = '1';
    alignGroup.innerHTML = '<label>Alignment</label>';
    const alignSelect = document.createElement('select');
    alignSelect.className = 'select-dropdown';
    alignSelect.style.width = '100%';
    alignSelect.style.padding = '8px';
    alignSelect.style.borderRadius = '4px';
    alignSelect.style.background = 'var(--bg-card)';
    alignSelect.style.color = 'var(--text-color)';
    alignSelect.style.border = '1px solid var(--border-color)';
    alignSelect.innerHTML = `
      <option value="0">Left</option>
      <option value="1">Center</option>
      <option value="2">Right</option>
    `;
    alignSelect.value = String(curFields.textAlignment !== undefined ? curFields.textAlignment : 0);
    alignSelect.addEventListener('change', () => {
      syncLabelProps('textAlignment', parseInt(alignSelect.value, 10));
    });
    alignGroup.appendChild(alignSelect);

    rowGroup.appendChild(sizeGroup);
    rowGroup.appendChild(alignGroup);
    fieldsContainer.appendChild(rowGroup);

    // 3. Outline Toggle & Options
    const outlineGroup = document.createElement('div');
    outlineGroup.className = 'input-group';
    const outlineCheckboxLabel = document.createElement('label');
    outlineCheckboxLabel.className = 'checkbox-container';
    const outlineInput = document.createElement('input');
    outlineInput.type = 'checkbox';
    outlineInput.checked = curFields.outline === true;
    const outlineCheckmark = document.createElement('span');
    outlineCheckmark.className = 'checkmark';
    outlineCheckboxLabel.appendChild(outlineInput);
    outlineCheckboxLabel.appendChild(outlineCheckmark);
    outlineCheckboxLabel.appendChild(document.createTextNode(' Enable Text Outline'));
    outlineGroup.appendChild(outlineCheckboxLabel);
    fieldsContainer.appendChild(outlineGroup);

    const outlineRow = document.createElement('div');
    outlineRow.className = 'form-row';
    outlineRow.style.display = outlineInput.checked ? 'flex' : 'none';
    outlineRow.style.gap = '8px';

    const outlineColorGroup = document.createElement('div');
    outlineColorGroup.className = 'input-group';
    outlineColorGroup.style.flex = '1';
    outlineColorGroup.innerHTML = '<label>Outline Color</label>';
    const outlineColorInput = document.createElement('input');
    outlineColorInput.type = 'color';
    outlineColorInput.value = argbToHex(curFields.outlineColor !== undefined ? curFields.outlineColor : 0xFF000000);
    outlineColorInput.addEventListener('input', () => {
      syncLabelProps('outlineColor', hexToArgb(outlineColorInput.value));
    });
    outlineColorGroup.appendChild(outlineColorInput);

    const outlineWidthGroup = document.createElement('div');
    outlineWidthGroup.className = 'input-group';
    outlineWidthGroup.style.flex = '1';
    outlineWidthGroup.innerHTML = '<label>Width (px)</label>';
    const outlineWidthInput = document.createElement('input');
    outlineWidthInput.type = 'number';
    outlineWidthInput.min = 1;
    outlineWidthInput.max = 10;
    outlineWidthInput.value = curFields.outlineWidth !== undefined ? curFields.outlineWidth : 1;
    outlineWidthInput.addEventListener('input', () => {
      syncLabelProps('outlineWidth', parseInt(outlineWidthInput.value, 10) || 1);
    });
    outlineWidthGroup.appendChild(outlineWidthInput);

    outlineRow.appendChild(outlineColorGroup);
    outlineRow.appendChild(outlineWidthGroup);
    fieldsContainer.appendChild(outlineRow);

    outlineInput.addEventListener('change', () => {
      const isChecked = outlineInput.checked;
      outlineRow.style.display = isChecked ? 'flex' : 'none';
      syncLabelProps('outline', isChecked);
    });

    // 4. Shadow Toggle & Options
    const shadowGroup = document.createElement('div');
    shadowGroup.className = 'input-group';
    const shadowCheckboxLabel = document.createElement('label');
    shadowCheckboxLabel.className = 'checkbox-container';
    const shadowInput = document.createElement('input');
    shadowInput.type = 'checkbox';
    shadowInput.checked = curFields.shadow === true;
    const shadowCheckmark = document.createElement('span');
    shadowCheckmark.className = 'checkmark';
    shadowCheckboxLabel.appendChild(shadowInput);
    shadowCheckboxLabel.appendChild(shadowCheckmark);
    shadowCheckboxLabel.appendChild(document.createTextNode(' Enable Text Shadow'));
    shadowGroup.appendChild(shadowCheckboxLabel);
    fieldsContainer.appendChild(shadowGroup);

    const shadowRow = document.createElement('div');
    shadowRow.className = 'form-row';
    shadowRow.style.display = shadowInput.checked ? 'flex' : 'none';
    shadowRow.style.gap = '8px';

    const shadowColorGroup = document.createElement('div');
    shadowColorGroup.className = 'input-group';
    shadowColorGroup.style.flex = '1';
    shadowColorGroup.innerHTML = '<label>Shadow Color</label>';
    const shadowColorInput = document.createElement('input');
    shadowColorInput.type = 'color';
    shadowColorInput.value = argbToHex(curFields.shadowColor !== undefined ? curFields.shadowColor : 0xFF000000);
    shadowColorInput.addEventListener('input', () => {
      syncLabelProps('shadowColor', hexToArgb(shadowColorInput.value));
    });
    shadowColorGroup.appendChild(shadowColorInput);

    const shadowOffXGroup = document.createElement('div');
    shadowOffXGroup.className = 'input-group';
    shadowOffXGroup.style.flex = '1';
    shadowOffXGroup.innerHTML = '<label>Offset X</label>';
    const shadowOffXInput = document.createElement('input');
    shadowOffXInput.type = 'number';
    shadowOffXInput.value = curFields.shadowOffsetX !== undefined ? curFields.shadowOffsetX : 1;
    shadowOffXInput.addEventListener('input', () => {
      syncLabelProps('shadowOffsetX', parseInt(shadowOffXInput.value, 10) || 0);
    });
    shadowOffXGroup.appendChild(shadowOffXInput);

    const shadowOffYGroup = document.createElement('div');
    shadowOffYGroup.className = 'input-group';
    shadowOffYGroup.style.flex = '1';
    shadowOffYGroup.innerHTML = '<label>Offset Y</label>';
    const shadowOffYInput = document.createElement('input');
    shadowOffYInput.type = 'number';
    shadowOffYInput.value = curFields.shadowOffsetY !== undefined ? curFields.shadowOffsetY : 1;
    shadowOffYInput.addEventListener('input', () => {
      syncLabelProps('shadowOffsetY', parseInt(shadowOffYInput.value, 10) || 0);
    });
    shadowOffYGroup.appendChild(shadowOffYInput);

    shadowRow.appendChild(shadowColorGroup);
    shadowRow.appendChild(shadowOffXGroup);
    shadowRow.appendChild(shadowOffYGroup);
    fieldsContainer.appendChild(shadowRow);

    shadowInput.addEventListener('change', () => {
      const isChecked = shadowInput.checked;
      shadowRow.style.display = isChecked ? 'flex' : 'none';
      syncLabelProps('shadow', isChecked);
    });
  }
}

// Drawing Tools Hooks
function setupToolboxHooks() {
  const tools = document.querySelectorAll('.tool-btn');
  const brushOpts = document.getElementById('brush-options');
  const shapeOpts = document.getElementById('shape-options');

  tools.forEach(btn => {
    if (btn.id === 'tool-image' || btn.id === 'tool-replace') return;
    btn.addEventListener('click', () => {
      tools.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      const toolId = btn.id.replace('tool-', '');
      editor.activeToolId = toolId;
      
      // Hide selection box if changing tool
      if (toolId !== 'select' && toolId !== 'move') {
        editor.clearSelection();
      }

      // Context options visibility
      brushOpts.style.display = (toolId === 'brush') ? 'block' : 'none';
      shapeOpts.style.display = (toolId.startsWith('shape-') && toolId !== 'shape-line') ? 'block' : 'none';
    });
  });

  // Brush Size
  const sizeInput = document.getElementById('brush-size');
  const sizeVal = document.getElementById('brush-size-val');
  sizeInput.addEventListener('input', () => {
    sizeVal.textContent = sizeInput.value;
    editor.brushSize = parseInt(sizeInput.value, 10);
  });

  // Shape Fill
  const fillInput = document.getElementById('shape-fill');
  fillInput.addEventListener('change', () => {
    editor.shapeFill = fillInput.checked;
  });

  // Selection actions
  document.getElementById('btn-copy').addEventListener('click', () => editor.copySelection());
  document.getElementById('btn-cut').addEventListener('click', () => editor.cutSelection());
  document.getElementById('btn-paste').addEventListener('click', () => editor.pasteSelection());
  document.getElementById('btn-flip-h').addEventListener('click', () => editor.flipSelection(true));
  document.getElementById('btn-flip-v').addEventListener('click', () => editor.flipSelection(false));
  document.getElementById('btn-rotate-cw').addEventListener('click', () => editor.rotateSelection(true));
  document.getElementById('btn-clear-select').addEventListener('click', () => editor.clearSelection());
}

// Layers Selection
function setupLayersHooks() {
  const visMode = document.getElementById('select-layer-vis-mode');

  visMode.addEventListener('change', () => {
    const val = visMode.value;
    if (val === 'all') {
      editor.layerVisibility = [true, true, true];
    } else if (val === 'bg_fg') {
      editor.layerVisibility = [true, true, false];
    } else if (val === 'bg') {
      editor.layerVisibility = [true, false, false];
    }
    editor.draw();
  });
}

// View Toggles
function setupViewOptionHooks() {
  const grid = document.getElementById('toggle-grid');
  grid.addEventListener('change', () => {
    editor.showGrid = grid.checked;
    editor.draw();
  });

  const colors = document.getElementById('toggle-bg-color');
  colors.addEventListener('change', () => {
    editor.useWorldColors = colors.checked;
    editor.draw();
  });

  const minimapToggle = document.getElementById('toggle-minimap');
  minimapToggle.addEventListener('change', () => {
    const panel = document.getElementById('minimap-panel');
    if (panel) {
      panel.style.display = minimapToggle.checked ? 'block' : 'none';
    }
  });
}

// Local File Operations removed. Cloud Sync Only.

// Authentication & Server Sync
function setupAuthAndSyncHooks() {
  const loginBtn = document.getElementById('btn-login');
  const loginTokenBtn = document.getElementById('btn-login-token');
  const logoutBtn = document.getElementById('btn-logout');
  const emailInput = document.getElementById('auth-email');
  const passInput = document.getElementById('auth-password');
  const tokenInput = document.getElementById('auth-token');

  emailInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') loginBtn.click();
  });
  passInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') loginBtn.click();
  });
  tokenInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') loginTokenBtn.click();
  });

  // Login via Email/Password
  loginBtn.addEventListener('click', async () => {
    const email = emailInput.value.trim();
    const password = passInput.value;
    if (!email || !password) return alert('Please enter both email and password.');

    loginBtn.disabled = true;
    loginBtn.textContent = 'Logging in...';

    try {
      const res = await loginWithPassword(email, password);
      authToken = res.token;
      
      // Fetch worlds list to verify token and retrieve public list
      const worlds = await fetchWorlds(authToken);
      
      authRecord = res.record || parseAuthToken(authToken) || { id: '', username: 'Token Authenticated', role: 'Player' };

      localStorage.setItem('pw_auth_token', authToken);
      localStorage.setItem('pw_user_record', JSON.stringify(authRecord));

      onLoggedIn(worlds);
    } catch (err) {
      alert(err.message);
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = 'Log In to PixelWalker';
    }
  });

  // Login via Token directly
  loginTokenBtn.addEventListener('click', async () => {
    const token = tokenInput.value.trim();
    if (!token) return alert('Please enter an auth token.');

    loginTokenBtn.disabled = true;
    try {
      authToken = token;
      // Fetch worlds list to verify token
      const worlds = await fetchWorlds(authToken);
      
      // Parse token payload to retrieve proper user ID and details
      authRecord = parseAuthToken(authToken) || { id: '', username: 'Token Authenticated', role: 'Player' };
      
      localStorage.setItem('pw_auth_token', authToken);
      localStorage.setItem('pw_user_record', JSON.stringify(authRecord));

      onLoggedIn(worlds);
    } catch(err) {
      alert('Failed to authenticate token. Ensure the token is valid.');
      authToken = null;
    } finally {
      loginTokenBtn.disabled = false;
    }
  });

  // Logout
  logoutBtn.addEventListener('click', () => {
    authToken = null;
    authRecord = null;
    localStorage.removeItem('pw_auth_token');
    localStorage.removeItem('pw_user_record');
    
    document.getElementById('auth-logged-in').style.display = 'none';
    document.getElementById('auth-logged-out').style.display = 'flex';
    document.getElementById('connection-status').querySelector('.status-dot').className = 'status-dot offline';
    document.getElementById('connection-status').querySelector('.status-label').textContent = 'Disconnected';
  });

  // Sync dropdown with manual input
  const dropdown = document.getElementById('select-worlds-dropdown');
  const worldIdInput = document.getElementById('input-world-id');
  const worldCodeInput = document.getElementById('input-world-code');
  const importBtn = document.getElementById('btn-import-world');

  dropdown.addEventListener('change', () => {
    if (dropdown.value) {
      worldIdInput.value = dropdown.value;
    }
  });

  worldIdInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') importBtn.click();
  });
  worldCodeInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') importBtn.click();
  });

  // Import World
  document.getElementById('btn-import-world').addEventListener('click', async () => {
    const roomId = worldIdInput.value.trim();
    if (!roomId) return alert('Please enter or select a World ID to import.');

    const importBtn = document.getElementById('btn-import-world');
    importBtn.disabled = true;
    
    try {
      const statusLabel = document.getElementById('connection-status').querySelector('.status-label');
      const dot = document.getElementById('connection-status').querySelector('.status-dot');
      dot.className = 'status-dot online';

      const data = await importWorldFromLive(roomId, authToken, (status) => {
        statusLabel.textContent = status;
      });

      editor.loadWorldData(data.width, data.height, data.meta, data.layers, data.labels);
      
      // Update header world name
      document.getElementById('room-info').style.display = 'flex';
      document.getElementById('current-room-name').textContent = data.meta.title || roomId;

      statusLabel.textContent = 'Import Complete';
    } catch (err) {
      alert('Import failed: ' + err.message);
      document.getElementById('connection-status').querySelector('.status-dot').className = 'status-dot offline';
      document.getElementById('connection-status').querySelector('.status-label').textContent = 'Disconnected';
    } finally {
      importBtn.disabled = false;
    }
  });

  // Export World
  document.getElementById('btn-export-world').addEventListener('click', async () => {
    const roomId = worldIdInput.value.trim();
    if (!roomId) return alert('Please enter or select a World ID to export to.');

    const secretCode = document.getElementById('input-world-code').value.trim() || null;

    if (!confirm('This will overwrite blocks in the live world on the server. Proceed?')) return;

    const exportBtn = document.getElementById('btn-export-world');
    exportBtn.disabled = true;

    try {
      const statusLabel = document.getElementById('connection-status').querySelector('.status-label');
      const dot = document.getElementById('connection-status').querySelector('.status-dot');
      dot.className = 'status-dot online';

      const state = {
        width: editor.width,
        height: editor.height,
        layers: editor.layers,
        labels: editor.labels
      };

      await exportWorldToLive(roomId, authToken, state, 
        (status) => {
          statusLabel.textContent = status;
        },
        (sent, total) => {
          statusLabel.textContent = `Syncing... ${sent}/${total} blocks (${Math.round(sent*100/total)}%)`;
        },
        secretCode
      );

      statusLabel.textContent = 'Sync Complete';
    } catch (err) {
      alert('Sync failed: ' + err.message);
      document.getElementById('connection-status').querySelector('.status-dot').className = 'status-dot offline';
      document.getElementById('connection-status').querySelector('.status-label').textContent = 'Disconnected';
    } finally {
      exportBtn.disabled = false;
    }
  });
}

async function onLoggedIn(prefetchedWorlds = null) {
  document.getElementById('auth-logged-out').style.display = 'none';
  document.getElementById('auth-logged-in').style.display = 'flex';
  document.getElementById('auth-username').textContent = authRecord.username || 'Token Authenticated';
  document.getElementById('auth-role').textContent = authRecord.role || 'Player';

  try {
    const worlds = prefetchedWorlds || await fetchWorlds(authToken);
    const dropdown = document.getElementById('select-worlds-dropdown');
    dropdown.innerHTML = '<option value="">-- Choose World --</option>';

    // Filter worlds to only show those owned by the authenticated user if user ID is available
    let ownedWorlds = worlds;
    if (authRecord && authRecord.id) {
      ownedWorlds = worlds.filter(w => w.owner === authRecord.id);
    }

    ownedWorlds.forEach(w => {
      const opt = document.createElement('option');
      opt.value = w.id;
      opt.textContent = `${w.title || 'Untitled'} (${w.width}x${w.height})`;
      dropdown.appendChild(opt);
    });
  } catch(e) {
    console.error('Failed to populate worlds dropdown:', e);
  }
}

// Header Actions (Undo, Redo, Resize, Clear)
function setupHeaderActionHooks() {
  document.getElementById('btn-undo').addEventListener('click', () => editor.undo());
  document.getElementById('btn-redo').addEventListener('click', () => editor.redo());
  
  // Clear Level
  document.getElementById('btn-clear').addEventListener('click', () => {
    if (confirm('Clear the entire level? This will leave borders intact.')) {
      editor.clearWorld();
    }
  });

  // Resize Level Modal
  const resizeModal = document.getElementById('resize-modal');
  const resizeBtn = document.getElementById('btn-resize');
  const cancelBtn = document.getElementById('btn-resize-cancel');
  const confirmBtn = document.getElementById('btn-resize-confirm');
  const resizeW = document.getElementById('resize-w');
  const resizeH = document.getElementById('resize-h');

  resizeBtn.addEventListener('click', () => {
    resizeW.value = editor.width;
    resizeH.value = editor.height;
    resizeModal.style.display = 'flex';
  });

  cancelBtn.addEventListener('click', () => {
    resizeModal.style.display = 'none';
  });

  confirmBtn.addEventListener('click', () => {
    const w = parseInt(resizeW.value, 10);
    const h = parseInt(resizeH.value, 10);
    
    if (w >= 1 && w <= 500 && h >= 1 && h <= 500) {
      editor.resizeWorld(w, h);
      resizeModal.style.display = 'none';
    } else {
      alert('Dimensions must be between 1 and 500.');
    }
  });

  // Global Keybind listeners (Undo, Redo, Selection)
  window.addEventListener('keydown', e => {
    const activeTag = document.activeElement.tagName.toLowerCase();
    if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') {
      return; // typing inside inputs, do not trigger keybinds
    }

    // Number keys 1-9: Select hotbar slot
    if (e.key >= '1' && e.key <= '9') {
      const idx = parseInt(e.key, 10) - 1;
      selectHotbarSlot(idx);
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      editor.undo();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      editor.redo();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      if (editor.selection) {
        e.preventDefault();
        editor.copySelection();
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
      if (editor.selection) {
        e.preventDefault();
        editor.cutSelection();
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
      if (editor.copiedBuffer) {
        e.preventDefault();
        editor.pasteSelection();
      }
    }
    if (e.key === 'Escape') {
      editor.clearSelection();
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (editor.selection) {
        e.preventDefault();
        editor.cutSelection();
      }
    }
  });

  // Image Import Modal
  const imageModal = document.getElementById('image-modal');
  const imageBtn = document.getElementById('tool-image');
  const imageCancelBtn = document.getElementById('btn-image-cancel');
  const imageConfirmBtn = document.getElementById('btn-image-confirm');
  const imageInput = document.getElementById('image-input');
  const imageBlockType = document.getElementById('image-block-type');
  const imageMissingColor = document.getElementById('image-missing-color');

  let loadedImg = null;

  imageBtn.addEventListener('click', () => {
    imageInput.value = '';
    imageConfirmBtn.disabled = true;
    loadedImg = null;
    imageModal.style.display = 'flex';
  });

  imageCancelBtn.addEventListener('click', () => {
    imageModal.style.display = 'none';
  });

  imageInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) {
      imageConfirmBtn.disabled = true;
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        loadedImg = img;
        imageConfirmBtn.disabled = false;
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  });

  imageConfirmBtn.addEventListener('click', () => {
    if (!loadedImg) return;

    const blockType = imageBlockType.value;
    const missingColorOpt = imageMissingColor.value;

    const targetW = Math.min(loadedImg.width, editor.width);
    const targetH = Math.min(loadedImg.height, editor.height);

    // Create offscreen canvas to read pixels
    const imgCanvas = document.createElement('canvas');
    imgCanvas.width = loadedImg.width;
    imgCanvas.height = loadedImg.height;
    const imgCtx = imgCanvas.getContext('2d');
    imgCtx.drawImage(loadedImg, 0, 0);
    const imgData = imgCtx.getImageData(0, 0, loadedImg.width, loadedImg.height).data;

    // Helper to find nearest block
    const findNearestBlock = (r, g, b, allowedLayers) => {
      let best = null;
      let minDist = Infinity;
      for (const block of blocksData) {
        if (!block.MinimapColor) continue;
        if (!allowedLayers.includes(block.Layer)) continue;
        
        const val = block.MinimapColor;
        const br = (val >>> 16) & 0xFF;
        const bg = (val >>> 8) & 0xFF;
        const bb = val & 0xFF;
        
        const dist = (r - br) * (r - br) + (g - bg) * (g - bg) + (b - bb) * (b - bb);
        if (dist < minDist) {
          minDist = dist;
          best = block;
        }
      }
      return { block: best, dist: minDist };
    };

    editor.beginAction();

    for (let y = 0; y < targetH; y++) {
      for (let x = 0; x < targetW; x++) {
        const idx = (y * loadedImg.width + x) * 4;
        const r = imgData[idx];
        const g = imgData[idx + 1];
        const b = imgData[idx + 2];
        const a = imgData[idx + 3];

        if (a < 128) continue; // transparent pixel

        if (blockType === 'fg_only') {
          // Allowed layer is foreground (1)
          const { block, dist } = findNearestBlock(r, g, b, [1]);
          if ((missingColorOpt === 'nearest' || missingColorOpt === 'custom_bg') && block) {
            editor.setBlock(x, y, 1, { id: block.Id, fields: {} });
          } else if (missingColorOpt === 'empty') {
            if (block && dist <= 1500) {
              editor.setBlock(x, y, 1, { id: block.Id, fields: {} });
            } else {
              editor.setBlock(x, y, 1, { id: 0, fields: {} });
            }
          }
        } else if (blockType === 'bg_only') {
          // Allowed layer is background (0)
          if (missingColorOpt === 'custom_bg') {
            const hexVal = ((r << 16) | (g << 8) | b) >>> 0;
            editor.setBlock(x, y, 0, { id: 278, fields: { color: hexVal } });
          } else {
            const { block, dist } = findNearestBlock(r, g, b, [0]);
            if (missingColorOpt === 'nearest' && block) {
              editor.setBlock(x, y, 0, { id: block.Id, fields: {} });
            } else if (missingColorOpt === 'empty') {
              if (block && dist <= 1500) {
                editor.setBlock(x, y, 0, { id: block.Id, fields: {} });
              } else {
                editor.setBlock(x, y, 0, { id: 0, fields: {} });
              }
            }
          }
        } else if (blockType === 'fg_bg') {
          // Allowed layers are background (0) and foreground (1)
          const { block, dist } = findNearestBlock(r, g, b, [0, 1]);
          if (missingColorOpt === 'custom_bg') {
            if (block && dist <= 500) {
              editor.setBlock(x, y, block.Layer, { id: block.Id, fields: {} });
            } else {
              const hexVal = ((r << 16) | (g << 8) | b) >>> 0;
              editor.setBlock(x, y, 0, { id: 278, fields: { color: hexVal } });
            }
          } else if (missingColorOpt === 'nearest') {
            if (block) {
              editor.setBlock(x, y, block.Layer, { id: block.Id, fields: {} });
            }
          } else if (missingColorOpt === 'empty') {
            if (block && dist <= 1500) {
              editor.setBlock(x, y, block.Layer, { id: block.Id, fields: {} });
            }
            // else leave air/empty
          }
        }
      }
    }

    editor.commitAction();
    editor.draw();
    editor.updateMinimap();

    imageModal.style.display = 'none';
  });

  // Find and Replace Modal
  const replaceModal = document.getElementById('replace-modal');
  const replaceBtn = document.getElementById('tool-replace');
  const replaceCancelBtn = document.getElementById('btn-replace-cancel');
  const replaceConfirmBtn = document.getElementById('btn-replace-confirm');
  const replaceFindInput = document.getElementById('replace-find');
  const replaceWithInput = document.getElementById('replace-with');
  const replaceArgsInput = document.getElementById('replace-args');
  const btnFindSelected = document.getElementById('btn-replace-find-selected');
  const btnWithSelected = document.getElementById('btn-replace-with-selected');

  replaceBtn.addEventListener('click', () => {
    replaceFindInput.value = '';
    replaceWithInput.value = '';
    replaceArgsInput.value = '';
    replaceModal.style.display = 'flex';
  });

  replaceCancelBtn.addEventListener('click', () => {
    replaceModal.style.display = 'none';
  });

  // Helpers to resolve block ID
  const resolveBlockId = (val) => {
    if (!val || val.trim() === '') return null;
    const num = parseInt(val, 10);
    if (!isNaN(num)) return num;

    // Search by PaletteId case-insensitive
    const lowerVal = val.trim().toLowerCase();
    
    // Check if direct paletteId match
    const match = blocksData.find(b => b.PaletteId.toLowerCase() === lowerVal);
    if (match) return match.Id;

    // Check partial matches
    const partialMatch = blocksData.find(b => b.PaletteId.toLowerCase().includes(lowerVal));
    if (partialMatch) return partialMatch.Id;

    return null;
  };

  btnFindSelected.addEventListener('click', () => {
    if (editor.activeBlock) {
      const bMeta = editor.blocksById.get(editor.activeBlock.id);
      replaceFindInput.value = bMeta ? bMeta.PaletteId : editor.activeBlock.id;
    }
  });

  btnWithSelected.addEventListener('click', () => {
    if (editor.activeBlock) {
      const bMeta = editor.blocksById.get(editor.activeBlock.id);
      replaceWithInput.value = bMeta ? bMeta.PaletteId : editor.activeBlock.id;
    }
  });

  replaceConfirmBtn.addEventListener('click', () => {
    const findVal = replaceFindInput.value;
    const replaceVal = replaceWithInput.value;
    const argsText = replaceArgsInput.value.trim();

    const findId = resolveBlockId(findVal);
    const replaceId = resolveBlockId(replaceVal);

    if (findId === null) {
      alert(`Could not resolve Find block: "${findVal}"`);
      return;
    }
    if (replaceId === null) {
      alert(`Could not resolve Replace block: "${replaceVal}"`);
      return;
    }

    let replaceFields = {};
    if (argsText !== '') {
      try {
        replaceFields = JSON.parse(argsText);
        if (typeof replaceFields !== 'object' || replaceFields === null) {
          throw new Error('Must be a JSON object');
        }
      } catch (e) {
        alert('Invalid JSON in Arguments field:\n' + e.message);
        return;
      }
    }

    editor.beginAction();

    let replaceCount = 0;
    for (let l = 0; l < 3; l++) {
      for (let x = 0; x < editor.width; x++) {
        for (let y = 0; y < editor.height; y++) {
          const b = editor.layers[l][x][y];
          if (b && b.id === findId) {
            editor.setBlock(x, y, l, {
              id: replaceId,
              fields: { ...replaceFields }
            });
            replaceCount++;
          }
        }
      }
    }

    editor.commitAction();
    editor.draw();
    editor.updateMinimap();

    alert(`Successfully replaced ${replaceCount} blocks!`);
    replaceModal.style.display = 'none';
  });

  // Autocomplete UI logic helper for Find & Replace blocks
  const setupAutocomplete = (inputEl, suggestionsEl) => {
    const handleInput = () => {
      const query = inputEl.value.trim().toLowerCase();
      suggestionsEl.innerHTML = '';

      if (query === '') {
        suggestionsEl.style.display = 'none';
        return;
      }

      // Filter matches (limit to 10 results)
      const matches = blocksData.filter(b => 
        b.PaletteId.toLowerCase().includes(query) || 
        b.Id.toString().includes(query)
      ).slice(0, 10);

      if (matches.length === 0) {
        suggestionsEl.style.display = 'none';
        return;
      }

      matches.forEach(b => {
        const item = document.createElement('div');
        item.className = 'suggestion-item';
        
        const icon = document.createElement('div');
        icon.className = 'suggestion-item-icon';
        const spriteStyle = getBlockSpriteStyle(b.PaletteId, b.Layer, 18);
        if (spriteStyle) {
          Object.assign(icon.style, spriteStyle);
        } else {
          icon.style.backgroundColor = b.MinimapColor ? argbToRgba(b.MinimapColor) : '#475569';
        }

        const nameLabel = document.createElement('span');
        nameLabel.className = 'suggestion-item-text';
        nameLabel.textContent = b.PaletteId;

        const idLabel = document.createElement('span');
        idLabel.className = 'suggestion-item-id';
        idLabel.textContent = `ID ${b.Id}`;

        item.appendChild(icon);
        item.appendChild(nameLabel);
        item.appendChild(idLabel);

        item.addEventListener('click', () => {
          inputEl.value = b.PaletteId;
          suggestionsEl.style.display = 'none';
        });

        suggestionsEl.appendChild(item);
      });

      suggestionsEl.style.display = 'block';
    };

    inputEl.addEventListener('input', handleInput);
    inputEl.addEventListener('focus', handleInput);

    // Hide suggestions on document click
    document.addEventListener('click', (e) => {
      if (!inputEl.contains(e.target) && !suggestionsEl.contains(e.target)) {
        suggestionsEl.style.display = 'none';
      }
    });
  };

  const replaceFindSuggestions = document.getElementById('replace-find-suggestions');
  const replaceWithSuggestions = document.getElementById('replace-with-suggestions');

  setupAutocomplete(replaceFindInput, replaceFindSuggestions);
  setupAutocomplete(replaceWithInput, replaceWithSuggestions);
}

function setupCollapsiblePanels() {
  document.querySelectorAll('.section-title.collapsible').forEach(title => {
    title.addEventListener('click', () => {
      const section = title.closest('.panel-section');
      if (section) {
        section.classList.toggle('collapsed');
      }
    });
  });
}

// Hotbar State & Handlers
let hotbarBlocks = Array(9).fill(null);
let activeHotbarIndex = 0;

function setupHotbar() {
  const slots = document.querySelectorAll('.hotbar-slot');

  try {
    const saved = localStorage.getItem('pw_hotbar');
    if (saved) {
      hotbarBlocks = JSON.parse(saved);
    } else {
      // Default hotbar slots loaded initially: ID 0 is eraser
      hotbarBlocks[0] = { Id: 0, PaletteId: 'empty_block', Layer: 1, MinimapColor: 0 };
    }
  } catch(e) {
    console.error('Failed to load hotbar:', e);
  }

  slots.forEach(slot => {
    const idx = parseInt(slot.dataset.slot, 10);

    slot.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    slot.addEventListener('drop', (e) => {
      e.preventDefault();
      try {
        const raw = e.dataTransfer.getData('text/plain');
        if (raw) {
          const block = JSON.parse(raw);
          hotbarBlocks[idx] = block;
          localStorage.setItem('pw_hotbar', JSON.stringify(hotbarBlocks));
          renderHotbar();
          selectHotbarSlot(idx);
        }
      } catch(err) {
        console.error('Failed to drop block:', err);
      }
    });

    slot.addEventListener('click', () => {
      selectHotbarSlot(idx);
    });
  });

  const resetBtn = document.getElementById('btn-reset-hotbar');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      hotbarBlocks = Array(9).fill(null);
      hotbarBlocks[0] = { Id: 0, PaletteId: 'empty_block', Layer: 1, MinimapColor: 0 };
      localStorage.setItem('pw_hotbar', JSON.stringify(hotbarBlocks));
      renderHotbar();
      selectHotbarSlot(0);
    });
  }

  renderHotbar();
  
  // Select slot 0 on startup if it contains a block
  if (hotbarBlocks[0]) {
    selectHotbarSlot(0);
  }
}

function renderHotbar() {
  const slots = document.querySelectorAll('.hotbar-slot');
  slots.forEach(slot => {
    const idx = parseInt(slot.dataset.slot, 10);
    const b = hotbarBlocks[idx];
    slot.innerHTML = '';

    if (b) {
      const icon = document.createElement('div');
      icon.className = 'palette-item-icon';
      
      if (b.Id === 0) {
        icon.className = 'palette-item-icon empty-eraser';
        icon.innerHTML = '⌧';
      } else {
        const spriteStyle = getBlockSpriteStyle(b.PaletteId, b.Layer, 24);
        if (spriteStyle) {
          Object.assign(icon.style, spriteStyle);
        } else {
          icon.style.backgroundColor = b.MinimapColor ? argbToRgba(b.MinimapColor) : '#475569';
        }
      }
      slot.appendChild(icon);
      slot.title = `${b.PaletteId} (Press ${idx + 1})`;
    } else {
      slot.textContent = idx + 1;
      slot.title = `Empty Slot (Drag block here to pin)`;
    }

    if (idx === activeHotbarIndex) {
      slot.classList.add('active');
    } else {
      slot.classList.remove('active');
    }
  });
}

function selectHotbarSlot(idx) {
  if (idx < 0 || idx >= 9) return;
  activeHotbarIndex = idx;
  const b = hotbarBlocks[idx];
  if (b) {
    editor.activeBlock = { id: b.Id, fields: {} };
    renderBlockPropertiesEditor(b);
    
    // Highlight active state inside sidebar block palette
    document.querySelectorAll('.palette-item').forEach(el => el.classList.remove('active'));
  }
  renderHotbar();
}

function setupLabelInspectorModal() {
  const modal = document.getElementById('label-modal');
  const btnClose = document.getElementById('btn-label-close');
  const btnSave = document.getElementById('btn-label-save');
  const btnDelete = document.getElementById('btn-label-delete');

  const inputText = document.getElementById('lbl-modal-text');
  const inputTileX = document.getElementById('lbl-modal-tilex');
  const inputTileY = document.getElementById('lbl-modal-tiley');
  const inputColor = document.getElementById('lbl-modal-color');
  const selectLayer = document.getElementById('lbl-modal-layer');
  const inputSize = document.getElementById('lbl-modal-size');
  const selectAlign = document.getElementById('lbl-modal-align');

  const checkOutline = document.getElementById('lbl-modal-outline');
  const rowOutline = document.getElementById('lbl-modal-outline-row');
  const inputOutlineColor = document.getElementById('lbl-modal-outline-color');
  const inputOutlineWidth = document.getElementById('lbl-modal-outline-width');

  const checkShadow = document.getElementById('lbl-modal-shadow');
  const rowShadow = document.getElementById('lbl-modal-shadow-row');
  const inputShadowColor = document.getElementById('lbl-modal-shadow-color');
  const inputShadowOffX = document.getElementById('lbl-modal-shadow-offx');
  const inputShadowOffY = document.getElementById('lbl-modal-shadow-offy');

  const inputMaxWidth = document.getElementById('lbl-modal-maxwidth');
  const inputCharSpacing = document.getElementById('lbl-modal-charspacing');

  let curLabel = null;

  const syncModalToLabel = () => {
    if (!curLabel) return;
    curLabel.text = inputText.value;
    curLabel.x = (parseInt(inputTileX.value, 10) || 0) * 16;
    curLabel.y = (parseInt(inputTileY.value, 10) || 0) * 16;
    curLabel.color = hexToArgb(inputColor.value);
    curLabel.renderLayer = parseInt(selectLayer.value, 10) || 0;
    curLabel.fontSize = parseInt(inputSize.value, 10) || 12;
    curLabel.textAlignment = parseInt(selectAlign.value, 10) || 0;

    curLabel.outline = checkOutline.checked;
    curLabel.outlineColor = hexToArgb(inputOutlineColor.value);
    curLabel.outlineWidth = parseInt(inputOutlineWidth.value, 10) || 1;

    curLabel.shadow = checkShadow.checked;
    curLabel.shadowColor = hexToArgb(inputShadowColor.value);
    curLabel.shadowOffsetX = parseInt(inputShadowOffX.value, 10) || 1;
    curLabel.shadowOffsetY = parseInt(inputShadowOffY.value, 10) || 1;

    curLabel.maxWidth = parseInt(inputMaxWidth.value, 10);
    curLabel.characterSpacing = parseInt(inputCharSpacing.value, 10) || 0;

    // Sync to sign block if present at grid (tileX, tileY)
    const tileX = Math.floor(curLabel.x / 16);
    const tileY = Math.floor(curLabel.y / 16);
    if (tileX >= 0 && tileX < editor.width && tileY >= 0 && tileY < editor.height) {
      for (let l = 0; l < 3; l++) {
        const b = editor.layers[l][tileX][tileY];
        if (b && b.id !== 0) {
          const bMeta = editor.blocksById.get(b.id);
          if (bMeta && bMeta.Fields && bMeta.Fields.some(f => f.Name === 'text')) {
            b.fields.text = curLabel.text;
            b.fields.color = curLabel.color;
            b.fields.fontSize = curLabel.fontSize;
            b.fields.textAlignment = curLabel.textAlignment;
            b.fields.renderLayer = curLabel.renderLayer;
          }
        }
      }
    }

    editor.draw();
  };

  // Wire input listeners for real-time live preview while editing!
  const inputs = [
    inputText, inputTileX, inputTileY, inputColor, selectLayer, inputSize,
    selectAlign, inputOutlineColor, inputOutlineWidth, inputShadowColor,
    inputShadowOffX, inputShadowOffY, inputMaxWidth, inputCharSpacing
  ];
  inputs.forEach(inp => {
    inp.addEventListener('input', syncModalToLabel);
    inp.addEventListener('change', syncModalToLabel);
  });

  checkOutline.addEventListener('change', () => {
    rowOutline.style.display = checkOutline.checked ? 'flex' : 'none';
    syncModalToLabel();
  });

  checkShadow.addEventListener('change', () => {
    rowShadow.style.display = checkShadow.checked ? 'flex' : 'none';
    syncModalToLabel();
  });

  // Open Inspector Modal when a label is clicked/selected
  editor.onSelectLabel = (lbl) => {
    if (!lbl) {
      modal.style.display = 'none';
      return;
    }
    curLabel = lbl;
    inputText.value = lbl.text || '';
    inputTileX.value = Math.floor(lbl.x / 16);
    inputTileY.value = Math.floor(lbl.y / 16);

    const textCol = (lbl.color !== undefined && lbl.color !== 0) ? lbl.color : 0xFFFFFFFF;
    inputColor.value = argbToHex(textCol);

    selectLayer.value = String(lbl.renderLayer !== undefined ? lbl.renderLayer : 1);
    inputSize.value = lbl.fontSize || 12;

    let alignVal = 0;
    if (lbl.textAlignment === 1 || lbl.textAlignment === 'CENTER') alignVal = 1;
    else if (lbl.textAlignment === 2 || lbl.textAlignment === 'RIGHT') alignVal = 2;
    selectAlign.value = String(alignVal);

    checkOutline.checked = lbl.outline === true;
    rowOutline.style.display = checkOutline.checked ? 'flex' : 'none';
    inputOutlineColor.value = argbToHex(lbl.outlineColor !== undefined ? lbl.outlineColor : 0xFF000000);
    inputOutlineWidth.value = lbl.outlineWidth || 1;

    checkShadow.checked = lbl.shadow === true;
    rowShadow.style.display = checkShadow.checked ? 'flex' : 'none';
    inputShadowColor.value = argbToHex(lbl.shadowColor !== undefined ? lbl.shadowColor : 0xFF000000);
    inputShadowOffX.value = lbl.shadowOffsetX !== undefined ? lbl.shadowOffsetX : 1;
    inputShadowOffY.value = lbl.shadowOffsetY !== undefined ? lbl.shadowOffsetY : 1;

    inputMaxWidth.value = lbl.maxWidth !== undefined ? lbl.maxWidth : -1;
    inputCharSpacing.value = lbl.characterSpacing || 0;

    modal.style.display = 'flex';
  };

  if (btnClose) {
    btnClose.addEventListener('click', () => {
      modal.style.display = 'none';
    });
  }

  if (btnSave) {
    btnSave.addEventListener('click', () => {
      syncModalToLabel();
      modal.style.display = 'none';
      editor.statusCallback('Saved label properties.');
    });
  }

  if (btnDelete) {
    btnDelete.addEventListener('click', () => {
      if (!curLabel) return;
      editor.labels = editor.labels.filter(l => l !== curLabel);
      editor.selectedLabel = null;
      modal.style.display = 'none';
      editor.draw();
      editor.statusCallback('Deleted label.');
    });
  }
}

// Start the app on DOM Load
window.addEventListener('DOMContentLoaded', initApp);
