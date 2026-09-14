import { argbToRgba } from './utils.js';
import { drawBlockSprite, drawAtlasNumber } from './assets.js';

function formatBlockFieldsCompact(fields) {
  if (!fields || Object.keys(fields).length === 0) return '';
  const parts = [];
  for (const [key, val] of Object.entries(fields)) {
    let valStr = typeof val === 'object' ? JSON.stringify(val) : String(val);
    if (typeof val === 'string' && valStr.length > 25) {
      valStr = valStr.slice(0, 25) + '...';
    }
    parts.push(`${key}=${valStr}`);
  }
  return ` [${parts.join(', ')}]`;
}

export class PixelEditor {
  constructor(canvas, container, statusCallback = () => {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;
    this.container = container;
    this.statusCallback = statusCallback;

    // World state
    this.width = 200;
    this.height = 200;
    this.meta = { title: 'Untitled World', backgroundColor: 0xFF0b0f19 };
    
    // Layers: 0 = Background, 1 = Foreground, 2 = Overlay/Liquid
    this.layers = [
      this.createLayer(0),
      this.createLayer(1),
      this.createLayer(2)
    ];

    // Text labels
    this.labels = [];

    // Blocks DB (loaded from blocks.json)
    this.blocksDb = [];
    this.blocksById = new Map();
    this.blocksByPaletteId = new Map();

    // Editor configuration
    this.zoom = 16; // Pixels per block
    this.panX = 50;  // Viewport offset
    this.panY = 50;
    this.showGrid = true;
    this.useWorldColors = true;
    this.autoRouteLayer = true;
    
    // Layer visibility states
    this.layerVisibility = [true, true, true];

    // Eraser helper layer locking
    this.lockedEraserLayer = null;
    this.isRightClickEraser = false;

    // Active block to draw
    this.activeBlock = { id: 283, fields: {} }; // Basic Gray

    // Drawing interaction state
    this.isDrawing = false;
    this.isPanning = false;
    this.lastMouseX = 0;
    this.lastMouseY = 0;
    this.activeToolId = 'pencil'; // pencil, brush, fill, shape-line, shape-rect, shape-circle, select
    
    // Tool config
    this.brushSize = 3;
    this.shapeFill = false;

    // Selection state
    this.selection = null; // { x, y, w, h }
    this.copiedBuffer = null; // { w, h, layers }
    this.isDraggingSelection = false;
    this.selectionDragStartGrid = null;
    this.selectionDragStartPos = null;
    this.selectionDragBuffer = null;

    // Undo/Redo Stacks
    this.undoStack = [];
    this.redoStack = [];
    this.currentActionChanges = [];

    // Inspection and placed block editing
    this.onBlockInspected = null;
    this.activeEditingCoordinate = null;

    // Register event handlers
    this.initEvents();

    // Auto-redraw canvas when custom font (NokiaFC22) completes loading
    if (typeof document !== 'undefined' && document.fonts) {
      document.fonts.ready.then(() => {
        this.draw();
      });
    }
  }

  createLayer(layerId) {
    // Fill with empty (id: 0)
    // For Foreground (layer 1), generate borders of basic_gray (id: 283) or basic gray if border
    const grid = Array.from({ length: this.width }, () =>
      Array.from({ length: this.height }, () => ({ id: 0, fields: {} }))
    );

    // Standard PixelWalker borders on Layer 1
    if (layerId === 1) {
      for (let x = 0; x < this.width; x++) {
        for (let y = 0; y < this.height; y++) {
          if (x === 0 || x === this.width - 1 || y === 0 || y === this.height - 1) {
            grid[x][y] = { id: 283, fields: {} }; // basic_gray
          }
        }
      }
    }
    return grid;
  }

  setBlocksDatabase(blocksJson) {
    this.blocksDb = blocksJson;
    this.blocksById.clear();
    this.blocksByPaletteId.clear();
    
    blocksJson.forEach(b => {
      this.blocksById.set(b.Id, b);
      this.blocksByPaletteId.set(b.PaletteId, b);
    });
  }

  resizeWorld(newW, newH) {
    // Record current action for undo
    const oldW = this.width;
    const oldH = this.height;
    const oldLayers = JSON.parse(JSON.stringify(this.layers));
    const oldLabels = JSON.parse(JSON.stringify(this.labels));

    this.width = newW;
    this.height = newH;
    
    // Create new layers and copy blocks
    const newLayers = [
      Array.from({ length: newW }, () => Array.from({ length: newH }, () => ({ id: 0, fields: {} }))),
      Array.from({ length: newW }, () => Array.from({ length: newH }, () => ({ id: 0, fields: {} }))),
      Array.from({ length: newW }, () => Array.from({ length: newH }, () => ({ id: 0, fields: {} })))
    ];

    // Copy old blocks
    for (let l = 0; l < 3; l++) {
      for (let x = 0; x < newW; x++) {
        for (let y = 0; y < newH; y++) {
          if (x < oldW && y < oldH) {
            newLayers[l][x][y] = oldLayers[l][x][y];
          } else {
            // Apply borders to Layer 1 for outer edges if expanding
            if (l === 1 && (x === 0 || x === newW - 1 || y === 0 || y === newH - 1)) {
              newLayers[l][x][y] = { id: 283, fields: {} };
            }
          }
        }
      }
    }

    this.layers = newLayers;
    
    // Filter labels inside borders
    this.labels = oldLabels.filter(lbl => lbl.x < newW && lbl.y < newH);

    this.pushHistory({
      type: 'resize',
      oldW, oldH, oldLayers, oldLabels,
      newW, newH, newLayers: JSON.parse(JSON.stringify(this.layers)), newLabels: JSON.parse(JSON.stringify(this.labels))
    });

    this.updateCanvasSize();
    this.draw();
    this.updateMinimap();
  }

  clearWorld() {
    this.beginAction();
    for (let l = 0; l < 3; l++) {
      for (let x = 0; x < this.width; x++) {
        for (let y = 0; y < this.height; y++) {
          const isBorder = (l === 1) && (x === 0 || x === this.width - 1 || y === 0 || y === this.height - 1);
          const targetId = isBorder ? 283 : 0;
          this.setBlockDirect(x, y, l, { id: targetId, fields: {} });
        }
      }
    }
    this.labels = [];
    this.commitAction();
    this.draw();
    this.updateMinimap();
  }

  loadWorldData(width, height, meta, layers, labels) {
    this.width = width;
    this.height = height;
    this.meta = meta || { title: 'Untitled World', backgroundColor: 0xFF0b0f19 };
    this.layers = layers;
    this.labels = labels || [];
    this.selection = null;

    // Ensure all sign blocks have string text fields
    for (let l = 0; l < 3; l++) {
      for (let x = 0; x < this.width; x++) {
        for (let y = 0; y < this.height; y++) {
          const block = this.layers[l][x][y];
          if (block && block.id !== 0) {
            const blockMeta = this.blocksById.get(block.id);
            if (blockMeta && blockMeta.Fields && blockMeta.Fields.some(f => f.Name === 'text')) {
              if (typeof block.fields.text !== 'string') {
                block.fields.text = "";
              }
            }
          }
        }
      }
    }

    // Sync label text to sign block fields
    this.labels.forEach(lbl => {
      const x = lbl.x;
      const y = lbl.y;
      if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
        for (let l = 0; l < 3; l++) {
          const block = this.layers[l][x][y];
          if (block && block.id !== 0) {
            const blockMeta = this.blocksById.get(block.id);
            if (blockMeta && blockMeta.Fields && blockMeta.Fields.some(f => f.Name === 'text')) {
              block.fields.text = lbl.text || "";
            }
          }
        }
      }
    });

    // Reset undo/redo
    this.undoStack = [];
    this.redoStack = [];
    this.updateUndoRedoButtons();

    this.updateCanvasSize();
    // Center camera
    this.centerCamera();
    this.draw();
    this.updateMinimap();
  }

  updateCanvasSize() {
    this.canvas.width = this.width * this.zoom;
    this.canvas.height = this.height * this.zoom;
    this.ctx.imageSmoothingEnabled = false;
    this.updateCanvasPosition();
    this.updateSelectionMarquee();
  }

  updateCanvasPosition() {
    this.canvas.style.transform = `translate(${this.panX}px, ${this.panY}px)`;
    const marquee = document.getElementById('selection-marquee');
    if (marquee) {
      marquee.style.transform = `translate(${this.panX}px, ${this.panY}px)`;
    }
  }

  centerCamera() {
    const parentW = this.container.clientWidth;
    const parentH = this.container.clientHeight;
    
    this.panX = Math.round((parentW - this.canvas.width) / 2);
    this.panY = Math.round((parentH - this.canvas.height) / 2);
    this.updateCanvasPosition();
  }

  initEvents() {
    // Prevent default right click menu
    this.container.addEventListener('contextmenu', e => e.preventDefault());

    // Mouse Press
    this.container.addEventListener('mousedown', e => {
      const coords = this.getGridCoords(e);
      const isLeftClick = e.button === 0;
      const isMiddleClick = e.button === 1;
      const isRightClick = e.button === 2;

      // 1. Check if we should drag active selection
      if (this.selection && (isMiddleClick || (isLeftClick && (this.activeToolId === 'select' || this.activeToolId === 'move')))) {
        if (coords.x >= this.selection.x && coords.x < this.selection.x + this.selection.w &&
            coords.y >= this.selection.y && coords.y < this.selection.y + this.selection.h) {
          e.preventDefault();
          this.isDraggingSelection = true;
          this.selectionDragStartGrid = { ...coords };
          this.selectionDragStartPos = { x: this.selection.x, y: this.selection.y };
          
          // Copy selection area blocks
          const { x, y, w, h } = this.selection;
          const layers = [
            Array.from({ length: w }, () => Array.from({ length: h }, () => null)),
            Array.from({ length: w }, () => Array.from({ length: h }, () => null)),
            Array.from({ length: w }, () => Array.from({ length: h }, () => null))
          ];
          for (let l = 0; l < 3; l++) {
            for (let bx = 0; bx < w; bx++) {
              for (let by = 0; by < h; by++) {
                const b = this.layers[l][x + bx][y + by];
                layers[l][bx][by] = { id: b.id, fields: { ...b.fields } };
              }
            }
          }
          this.selectionDragBuffer = { w, h, layers };
          
          // Erase the blocks from original position on canvas
          this.beginAction();
          this.clearCanvasSelectionArea();
          this.draw();
          return;
        }
      }

      if (isMiddleClick || (isLeftClick && this.activeToolId === 'move')) {
        // Panning Canvas
        e.preventDefault();
        this.isPanning = true;
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;
      } else if (isLeftClick || isRightClick) {
        if (isLeftClick && (this.activeToolId === 'inspect' || e.ctrlKey || e.altKey)) {
          // Ctrl+Click or Alt+Click: Inspect already placed block (finds topmost block at this coordinate)
          e.preventDefault();
          let inspectBlock = null;
          let inspectLayer = 1;
          for (let l = 2; l >= 0; l--) {
            if (this.layerVisibility[l]) {
              const b = this.layers[l][coords.x][coords.y];
              if (b && b.id !== 0) {
                inspectBlock = b;
                inspectLayer = l;
                break;
              }
            }
          }
          if (inspectBlock && this.onBlockInspected) {
            this.onBlockInspected(inspectBlock, coords.x, coords.y, inspectLayer);
          }
          return;
        }

        // Start Drawing
        this.isDrawing = true;
        this.isRightClickEraser = isRightClick;
        this.beginAction();
        this.lastDrawCoords = coords;
        this.lockedEraserLayer = null; // Clear locked layer at start of drag
        this.handleMouseDraw(e);
      }
    });

    // Mouse Move
    window.addEventListener('mousemove', e => {
      const rect = this.container.getBoundingClientRect();
      const parentX = e.clientX - rect.left;
      const parentY = e.clientY - rect.top;

      // Mouse Coordinates on Canvas Grid
      const canvasRect = this.canvas.getBoundingClientRect();
      const relativeX = e.clientX - canvasRect.left;
      const relativeY = e.clientY - canvasRect.top;
      
      const gridX = Math.floor(relativeX / (this.zoom * (canvasRect.width / this.canvas.width)));
      const gridY = Math.floor(relativeY / (this.zoom * (canvasRect.height / this.canvas.height)));

      const insideGrid = gridX >= 0 && gridX < this.width && gridY >= 0 && gridY < this.height;

      if (insideGrid) {
        let hoverBlockName = 'Air (empty)';
        let hoverBlock = null;
        for (let l = 2; l >= 0; l--) {
          if (this.layerVisibility[l]) {
            const b = this.layers[l][gridX][gridY];
            if (b && b.id !== 0) {
              hoverBlock = b;
              break;
            }
          }
        }
        if (hoverBlock) {
          const meta = this.blocksById.get(hoverBlock.id);
          hoverBlockName = meta ? `${meta.PaletteId} (ID: ${hoverBlock.id})` : `Unknown Block (${hoverBlock.id})`;
          if (hoverBlock.fields && Object.keys(hoverBlock.fields).length > 0) {
            hoverBlockName += formatBlockFieldsCompact(hoverBlock.fields);
          }
        }
        
        document.getElementById('coord-display').textContent = `X: ${gridX}, Y: ${gridY}`;
        document.getElementById('block-hover-display').textContent = hoverBlockName;
      } else {
        document.getElementById('coord-display').textContent = `X: -, Y: -`;
        document.getElementById('block-hover-display').textContent = ``;
      }

      if (this.activeToolId === 'label') {
        const canvasX = relativeX;
        const canvasY = relativeY;
        let foundLabel = null;
        if (this.labels) {
          for (let i = this.labels.length - 1; i >= 0; i--) {
            const lbl = this.labels[i];
            const bounds = this.getLabelBounds(lbl);
            if (canvasX >= bounds.boxX && canvasX <= bounds.boxX + bounds.boxW &&
                canvasY >= bounds.boxY && canvasY <= bounds.boxY + bounds.boxH) {
              foundLabel = lbl;
              break;
            }
          }
        }
        if (this.hoveredLabel !== foundLabel) {
          this.hoveredLabel = foundLabel;
          this.draw();
        }
        this.container.style.cursor = foundLabel ? 'pointer' : 'default';
      }

      if (this.isDraggingSelection) {
        const deltaX = gridX - this.selectionDragStartGrid.x;
        const deltaY = gridY - this.selectionDragStartGrid.y;
        
        this.selection.x = this.selectionDragStartPos.x + deltaX;
        this.selection.y = this.selectionDragStartPos.y + deltaY;
        
        this.updateSelectionMarquee();
        this.draw();
      } else if (this.isPanning) {
        const deltaX = e.clientX - this.lastMouseX;
        const deltaY = e.clientY - this.lastMouseY;
        this.panX += deltaX;
        this.panY += deltaY;
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;
        this.updateCanvasPosition();
        this.draw();
      } else if (this.isDrawing) {
        this.handleMouseDraw(e);
      }
    });

    // Mouse Release
    window.addEventListener('mouseup', e => {
      if (this.isDraggingSelection) {
        this.isDraggingSelection = false;
        
        // Paste the blocks at final location
        const { x, y, w, h } = this.selection;
        const { layers } = this.selectionDragBuffer;
        for (let l = 0; l < 3; l++) {
          for (let bx = 0; bx < w; bx++) {
            for (let by = 0; by < h; by++) {
              const tx = x + bx;
              const ty = y + by;
              if (tx >= 0 && tx < this.width && ty >= 0 && ty < this.height) {
                this.setBlock(tx, ty, l, layers[l][bx][by]);
              }
            }
          }
        }
        this.commitAction();
        this.selectionDragBuffer = null;
        this.draw();
      } else if (e.button === 1 || (e.button === 0 && this.activeToolId === 'move')) {
        this.isPanning = false;
      } else if ((e.button === 0 || e.button === 2) && this.isDrawing) {
        this.isDrawing = false;
        this.lastDrawCoords = null;
        this.lockedEraserLayer = null; // Reset layer lock at end of drag
        this.isRightClickEraser = false;
        
        // Finalize shape tools or commit standard draw actions
        if (this.activeToolId.startsWith('shape-') || this.activeToolId === 'select') {
          this.finalizeShapeTool(e);
        } else {
          this.commitAction();
        }
        this.draw();
      }
    });

    // Mouse Wheel: Zoom
    this.container.addEventListener('wheel', e => {
      e.preventDefault();
      
      const oldZoom = this.zoom;
      if (e.deltaY < 0) {
        // Zoom in (25% increments up to 200%)
        this.zoom = Math.min(32, this.zoom + 4);
      } else {
        // Zoom out (25% decrements down to 25%)
        this.zoom = Math.max(4, this.zoom - 4);
      }

      if (oldZoom !== this.zoom) {
        // Zoom centered around mouse position
        const rect = this.canvas.getBoundingClientRect();
        const mouseCanvasX = e.clientX - rect.left;
        const mouseCanvasY = e.clientY - rect.top;
        
        const zoomRatio = this.zoom / oldZoom;
        
        this.panX = e.clientX - this.container.getBoundingClientRect().left - mouseCanvasX * zoomRatio;
        this.panY = e.clientY - this.container.getBoundingClientRect().top - mouseCanvasY * zoomRatio;

        document.getElementById('zoom-display').textContent = `Zoom: ${Math.round(this.zoom * 100 / 16)}%`;

        this.updateCanvasSize();
        this.draw();
      }
    }, { passive: false });
  }

  // Translate Screen Mouse Client coords to Canvas Grid Coordinates
  getGridCoords(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;

    const gridX = Math.floor((x * scaleX) / this.zoom);
    const gridY = Math.floor((y * scaleY) / this.zoom);

    return { x: gridX, y: gridY };
  }

  drawBrushAt(x, y, layer, block) {
    const radius = Math.floor(this.brushSize / 2);
    const isEven = this.brushSize % 2 === 0;

    for (let dx = -radius; dx <= radius + (isEven ? 0 : 0); dx++) {
      for (let dy = -radius; dy <= radius + (isEven ? 0 : 0); dy++) {
        const bx = x + dx;
        const by = y + dy;
        if (bx >= 0 && bx < this.width && by >= 0 && by < this.height) {
          const dist = Math.sqrt(dx*dx + dy*dy);
          if (dist <= radius + 0.1) {
            this.setBlock(bx, by, layer, block);
          }
        }
      }
    }
  }

  drawSmoothLine(x1, y1, x2, y2, layer, block, tool) {
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const sx = (x1 < x2) ? 1 : -1;
    const sy = (y1 < y2) ? 1 : -1;
    let err = dx - dy;

    while (true) {
      if (tool === 'pencil') {
        this.setBlock(x1, y1, layer, block);
      } else if (tool === 'brush') {
        this.drawBrushAt(x1, y1, layer, block);
      }
      if (x1 === x2 && y1 === y2) break;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x1 += sx;
      }
      if (e2 < dx) {
        err += dx;
        y1 += sy;
      }
    }
  }

  // Handle standard drawings like Pencil, Brush, Fill
  handleMouseDraw(e) {
    const coords = this.getGridCoords(e);
    if (coords.x < 0 || coords.x >= this.width || coords.y < 0 || coords.y >= this.height) return;

    this.isShiftHeld = e.shiftKey;

    const blockToPlace = this.isRightClickEraser ? { id: 0, fields: {} } : this.activeBlock;
    const targetLayer = this.getRouteLayer(blockToPlace.id);

    // Check layer visibility
    if (!this.layerVisibility[targetLayer]) return;

    if (this.activeToolId === 'pencil') {
      if (this.lastDrawCoords) {
        this.drawSmoothLine(this.lastDrawCoords.x, this.lastDrawCoords.y, coords.x, coords.y, targetLayer, blockToPlace, 'pencil');
      } else {
        this.setBlock(coords.x, coords.y, targetLayer, blockToPlace);
      }
      this.lastDrawCoords = coords;
      this.draw();
    } else if (this.activeToolId === 'brush') {
      if (this.lastDrawCoords) {
        this.drawSmoothLine(this.lastDrawCoords.x, this.lastDrawCoords.y, coords.x, coords.y, targetLayer, blockToPlace, 'brush');
      } else {
        this.drawBrushAt(coords.x, coords.y, targetLayer, blockToPlace);
      }
      this.lastDrawCoords = coords;
      this.draw();
    } else if (this.activeToolId === 'fill') {
      // Flood Fill (called once on click)
      if (e.type === 'mousedown') {
        const startBlock = this.layers[targetLayer][coords.x][coords.y];
        if (startBlock.id !== blockToPlace.id || JSON.stringify(startBlock.fields) !== JSON.stringify(blockToPlace.fields)) {
          this.floodFill(coords.x, coords.y, targetLayer, startBlock, blockToPlace);
          this.commitAction();
          this.draw();
        }
      }
    } else if (this.activeToolId.startsWith('shape-') || this.activeToolId === 'select') {
      // Dragging shapes or selection box
      if (e.type === 'mousedown') {
        this.shapeStart = coords;
      }
      this.shapeEnd = coords;
      


      this.draw(); // Preview shape
    }
  }

  finalizeShapeTool(e) {
    if (!this.shapeStart || !this.shapeEnd) return;
    this.isShiftHeld = e.shiftKey;

    const blockToPlace = this.isRightClickEraser ? { id: 0, fields: {} } : this.activeBlock;

    if (blockToPlace.id === 0) {
      const sx = this.shapeStart.x;
      const sy = this.shapeStart.y;
      let targetL = 1;
      if (this.layers[2][sx][sy].id !== 0) {
        targetL = 2;
      } else if (this.layers[1][sx][sy].id !== 0) {
        targetL = 1;
      } else if (this.layers[0][sx][sy].id !== 0) {
        targetL = 0;
      }
      this.lockedEraserLayer = targetL;
    }
    
    const targetLayer = this.getRouteLayer(blockToPlace.id);
    if (!this.layerVisibility[targetLayer]) return;

    // Shift Key modifier
    const isShiftHeld = e.shiftKey;

    if (this.activeToolId === 'shape-line') {
      let x1 = this.shapeStart.x;
      let y1 = this.shapeStart.y;
      let x2 = this.shapeEnd.x;
      let y2 = this.shapeEnd.y;

      if (isShiftHeld) {
        // Constraint to straight or 45-degree diagonal
        const dx = x2 - x1;
        const dy = y2 - y1;
        if (Math.abs(dx) > Math.abs(dy) * 1.5) {
          y2 = y1;
        } else if (Math.abs(dy) > Math.abs(dx) * 1.5) {
          x2 = x1;
        } else {
          const dist = Math.round((Math.abs(dx) + Math.abs(dy)) / 2);
          x2 = x1 + Math.sign(dx) * dist;
          y2 = y1 + Math.sign(dy) * dist;
        }
      }

      this.drawLine(x1, y1, x2, y2, targetLayer, blockToPlace);
    } else if (this.activeToolId === 'shape-rect') {
      let x1 = this.shapeStart.x;
      let y1 = this.shapeStart.y;
      let x2 = this.shapeEnd.x;
      let y2 = this.shapeEnd.y;

      if (isShiftHeld) {
        const size = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
        x2 = x1 + Math.sign(x2 - x1) * size;
        y2 = y1 + Math.sign(y2 - y1) * size;
      }

      this.drawRect(x1, y1, x2, y2, targetLayer, blockToPlace, this.shapeFill);
    } else if (this.activeToolId === 'shape-circle') {
      let x1 = this.shapeStart.x;
      let y1 = this.shapeStart.y;
      let x2 = this.shapeEnd.x;
      let y2 = this.shapeEnd.y;

      if (isShiftHeld) {
        const size = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
        x2 = x1 + Math.sign(x2 - x1) * size;
        y2 = y1 + Math.sign(y2 - y1) * size;
      }

      this.drawCircle(x1, y1, x2, y2, targetLayer, blockToPlace, this.shapeFill);
    } else if (this.activeToolId === 'select') {
      // Set Selection Box
      const x = Math.min(this.shapeStart.x, this.shapeEnd.x);
      const y = Math.min(this.shapeStart.y, this.shapeEnd.y);
      const w = Math.abs(this.shapeStart.x - this.shapeEnd.x) + 1;
      const h = Math.abs(this.shapeStart.y - this.shapeEnd.y) + 1;
      
      this.setSelection(x, y, w, h);
    }

    this.shapeStart = null;
    this.shapeEnd = null;
    if (this.activeToolId !== 'select') {
      const marquee = document.getElementById('selection-marquee');
      if (marquee) marquee.style.display = 'none';
    }
    this.commitAction();
  }

  // Draw Line (Bresenham)
  drawLine(x1, y1, x2, y2, layer, block) {
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const sx = (x1 < x2) ? 1 : -1;
    const sy = (y1 < y2) ? 1 : -1;
    let err = dx - dy;

    while (true) {
      this.setBlock(x1, y1, layer, block);
      if (x1 === x2 && y1 === y2) break;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x1 += sx;
      }
      if (e2 < dx) {
        err += dx;
        y1 += sy;
      }
    }
  }

  // Draw Rectangle
  drawRect(x1, y1, x2, y2, layer, block, fill = false) {
    const startX = Math.min(x1, x2);
    const endX = Math.max(x1, x2);
    const startY = Math.min(y1, y2);
    const endY = Math.max(y1, y2);

    for (let x = startX; x <= endX; x++) {
      for (let y = startY; y <= endY; y++) {
        const isBorder = x === startX || x === endX || y === startY || y === endY;
        if (fill || isBorder) {
          this.setBlock(x, y, layer, block);
        }
      }
    }
  }

  // Draw Circle (Midpoint)
  drawCircle(x1, y1, x2, y2, layer, block, fill = false) {
    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2);
    const maxY = Math.max(y1, y2);
    const rx = Math.abs(x2 - x1) / 2;
    const ry = Math.abs(y2 - y1) / 2;
    const cx = minX + rx;
    const cy = minY + ry;

    const isFilled = (x, y) => {
      if (rx === 0 && ry === 0) return x === Math.round(cx) && y === Math.round(cy);
      if (rx === 0) return x === Math.round(cx) && y >= minY && y <= maxY;
      if (ry === 0) return y === Math.round(cy) && x >= minX && x <= maxX;
      const termX = Math.pow(x - cx, 2) / Math.pow(rx, 2);
      const termY = Math.pow(y - cy, 2) / Math.pow(ry, 2);
      return (termX + termY) <= 1.05;
    };

    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        if (isFilled(x, y)) {
          if (fill) {
            this.setBlock(x, y, layer, block);
          } else {
            const isBorder = 
              x === minX || x === maxX || y === minY || y === maxY ||
              !isFilled(x + 1, y) || !isFilled(x - 1, y) ||
              !isFilled(x, y + 1) || !isFilled(x, y - 1);
            
            if (isBorder) {
              this.setBlock(x, y, layer, block);
            }
          }
        }
      }
    }
  }

  // Flood Fill (4-way Queue-based)
  floodFill(startX, startY, layer, targetBlock, replacementBlock) {
    const queue = [[startX, startY]];
    const visited = new Set();
    const key = (x, y) => `${x},${y}`;

    const matchBlock = (x, y) => {
      const b = this.layers[layer][x][y];
      return b.id === targetBlock.id && JSON.stringify(b.fields) === JSON.stringify(targetBlock.fields);
    };

    while (queue.length > 0) {
      const [cx, cy] = queue.shift();
      const k = key(cx, cy);

      if (visited.has(k)) continue;
      visited.add(k);

      if (matchBlock(cx, cy)) {
        this.setBlock(cx, cy, layer, replacementBlock);

        // Add neighbors
        if (cx > 0) queue.push([cx - 1, cy]);
        if (cx < this.width - 1) queue.push([cx + 1, cy]);
        if (cy > 0) queue.push([cx, cy - 1]);
        if (cy < this.height - 1) queue.push([cx, cy + 1]);
      }
    }
  }

  // Set block with change tracking for Undo
  setBlock(x, y, layer, newBlock) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;

    if (newBlock.id === 0) {
      if (this.autoRouteLayer) {
        // Resolve topmost occupied layer at start of drag if not locked yet
        if (this.lockedEraserLayer === null) {
          let targetL = 1;
          if (this.layers[2][x][y].id !== 0) {
            targetL = 2;
          } else if (this.layers[1][x][y].id !== 0) {
            targetL = 1;
          } else if (this.layers[0][x][y].id !== 0) {
            targetL = 0;
          }
          this.lockedEraserLayer = targetL;
        }

        const targetL = this.lockedEraserLayer;
        const oldBlock = this.layers[targetL][x][y];
        if (oldBlock.id !== 0) {
          this.currentActionChanges.push({
            layer: targetL, x, y,
            oldBlock: { id: oldBlock.id, fields: { ...oldBlock.fields } },
            newBlock: { id: 0, fields: {} }
          });
          this.layers[targetL][x][y] = { id: 0, fields: {} };
          this.updateTextLabel(x, y, null); // Clear text label
        }
      } else {
        // Erase ONLY on the active layer
        const oldBlock = this.layers[layer][x][y];
        if (oldBlock.id !== 0) {
          this.currentActionChanges.push({
            layer, x, y,
            oldBlock: { id: oldBlock.id, fields: { ...oldBlock.fields } },
            newBlock: { id: 0, fields: {} }
          });
          this.layers[layer][x][y] = { id: 0, fields: {} };
          this.updateTextLabel(x, y, null); // Clear text label
        }
      }
      return;
    }

    const oldBlock = this.layers[layer][x][y];
    // Avoid redundant changes
    if (oldBlock.id === newBlock.id && JSON.stringify(oldBlock.fields) === JSON.stringify(newBlock.fields)) {
      return;
    }

    // Save to active action buffer
    this.currentActionChanges.push({
      layer, x, y,
      oldBlock: { id: oldBlock.id, fields: { ...oldBlock.fields } },
      newBlock: { id: newBlock.id, fields: { ...newBlock.fields } }
    });

    this.layers[layer][x][y] = {
      id: newBlock.id,
      fields: { ...newBlock.fields }
    };

    // Update global text labels list if block supports text fields
    const blockMeta = this.blocksById.get(newBlock.id);
    if (blockMeta && blockMeta.Fields && blockMeta.Fields.some(f => f.Name === 'text')) {
      const txt = newBlock.fields.text || "";
      if (txt) {
        this.updateTextLabel(x, y, {
          text: txt,
          color: newBlock.fields.color !== undefined ? newBlock.fields.color : 0xFFFFFFFF,
          fontSize: newBlock.fields.fontSize !== undefined ? newBlock.fields.fontSize : 12,
          textAlignment: newBlock.fields.textAlignment !== undefined ? newBlock.fields.textAlignment : 0,
          shadow: newBlock.fields.shadow || false,
          shadowColor: newBlock.fields.shadowColor !== undefined ? newBlock.fields.shadowColor : 0xFF000000,
          shadowOffsetX: newBlock.fields.shadowOffsetX !== undefined ? newBlock.fields.shadowOffsetX : 1,
          shadowOffsetY: newBlock.fields.shadowOffsetY !== undefined ? newBlock.fields.shadowOffsetY : 1,
          outline: newBlock.fields.outline || false,
          outlineColor: newBlock.fields.outlineColor !== undefined ? newBlock.fields.outlineColor : 0xFF000000,
          outlineWidth: newBlock.fields.outlineWidth !== undefined ? newBlock.fields.outlineWidth : 1
        });
      } else {
        this.updateTextLabel(x, y, null);
      }
    } else {
      // If replaced with a non-text block, clear label at this spot
      this.updateTextLabel(x, y, null);
    }
  }

  updateTextLabel(x, y, textOrProps) {
    if (textOrProps) {
      const textVal = typeof textOrProps === 'string' ? textOrProps : textOrProps.text;
      if (textVal === undefined || textVal === null || String(textVal).trim() === '') {
        this.labels = this.labels.filter(lbl => !(Math.floor(lbl.x / 16) === x && Math.floor(lbl.y / 16) === y));
        return;
      }
      let label = this.labels.find(lbl => Math.floor(lbl.x / 16) === x && Math.floor(lbl.y / 16) === y);
      if (!label) {
        label = {
          id: 'text_' + Math.random().toString(36).substr(2, 9),
          x: x * 16,
          y: y * 16,
          text: textVal,
          color: 0xFFFFFFFF,
          fontSize: 12,
          textAlignment: 0,
          renderLayer: 1,
          shadow: false,
          shadowColor: 0xFF000000,
          shadowOffsetX: 1,
          shadowOffsetY: 1,
          outline: false,
          outlineColor: 0xFF000000,
          outlineWidth: 1
        };
        this.labels.push(label);
      }
      if (typeof textOrProps === 'string') {
        label.text = textOrProps;
      } else {
        Object.assign(label, textOrProps);
        label.x = x * 16;
        label.y = y * 16;
      }
    } else {
      this.labels = this.labels.filter(lbl => !(Math.floor(lbl.x / 16) === x && Math.floor(lbl.y / 16) === y));
    }
  }

  setBlockDirect(x, y, layer, block) {
    this.layers[layer][x][y] = block;
  }

  // Automatic Routing for Layers based on block categories
  getRouteLayer(blockId) {
    const blockMeta = this.blocksById.get(blockId);
    if (!blockMeta) return 1; // Default Foreground
    
    // Background layer is 0
    if (blockMeta.Layer === 0) return 0;
    
    // Overlay/Liquid layer is 2
    if (blockMeta.Layer === 2) return 2;
    
    // Solid/Foreground layer is 1
    return 1;
  }

  // Selection box getters/setters
  setSelection(x, y, w, h) {
    this.selection = { x, y, w, h };
    this.updateSelectionMarquee();
    document.getElementById('selection-actions-panel').style.display = 'block';
  }

  clearSelection() {
    this.selection = null;
    this.updateSelectionMarquee();
    document.getElementById('selection-actions-panel').style.display = 'none';
    this.draw();
  }

  updateSelectionMarquee() {
    const marquee = document.getElementById('selection-marquee');
    if (!marquee) return;
    if (this.selection) {
      const border = 1;
      marquee.style.left = `${this.selection.x * this.zoom - border}px`;
      marquee.style.top = `${this.selection.y * this.zoom - border}px`;
      marquee.style.width = `${this.selection.w * this.zoom + border*2}px`;
      marquee.style.height = `${this.selection.h * this.zoom + border*2}px`;
      marquee.style.display = 'block';

      const badge = document.getElementById('selection-size-badge');
      if (badge) {
        badge.textContent = `${this.selection.w} x ${this.selection.h}`;
      }
    } else if (this.activeToolId.startsWith('shape-') || this.activeToolId === 'select') {
      if (!this.shapeStart || !this.shapeEnd) {
        marquee.style.display = 'none';
      }
    } else {
      marquee.style.display = 'none';
    }
  }

  ensureSelectionCaptured() {
    if (!this.selection) return false;
    const { x, y, w, h } = this.selection;
    const clipboardLayers = [
      Array.from({ length: w }, () => Array.from({ length: h }, () => null)),
      Array.from({ length: w }, () => Array.from({ length: h }, () => null)),
      Array.from({ length: w }, () => Array.from({ length: h }, () => null))
    ];

    for (let l = 0; l < 3; l++) {
      for (let bx = 0; bx < w; bx++) {
        for (let by = 0; by < h; by++) {
          const block = this.layers[l][x + bx][y + by];
          clipboardLayers[l][bx][by] = { id: block.id, fields: { ...block.fields } };
        }
      }
    }

    this.copiedBuffer = { w, h, layers: clipboardLayers };
    return true;
  }

  copySelection() {
    if (!this.selection) return;
    const { x, y, w, h } = this.selection;
    
    const clipboardLayers = [
      Array.from({ length: w }, () => Array.from({ length: h }, () => null)),
      Array.from({ length: w }, () => Array.from({ length: h }, () => null)),
      Array.from({ length: w }, () => Array.from({ length: h }, () => null))
    ];

    for (let l = 0; l < 3; l++) {
      for (let bx = 0; bx < w; bx++) {
        for (let by = 0; by < h; by++) {
          const block = this.layers[l][x + bx][y + by];
          clipboardLayers[l][bx][by] = { id: block.id, fields: { ...block.fields } };
        }
      }
    }

    this.copiedBuffer = { w, h, layers: clipboardLayers };
    this.statusCallback('Copied selected area to clipboard.');
  }

  cutSelection() {
    if (!this.selection) return;
    this.copySelection();
    
    // Clear selection on all layers
    this.beginAction();
    this.clearCanvasSelectionArea();
    this.commitAction();
    this.draw();
  }

  clearCanvasSelectionArea() {
    if (!this.selection) return;
    const { x, y, w, h } = this.selection;
    for (let l = 0; l < 3; l++) {
      for (let bx = 0; bx < w; bx++) {
        for (let by = 0; by < h; by++) {
          const tx = x + bx;
          const ty = y + by;
          if (tx >= 0 && tx < this.width && ty >= 0 && ty < this.height) {
            const isBorder = (l === 1) && (tx === 0 || tx === this.width - 1 || ty === 0 || ty === this.height - 1);
            const replacementId = isBorder ? 283 : 0;
            this.setBlock(tx, ty, l, { id: replacementId, fields: {} });
          }
        }
      }
    }
  }

  pasteSelection() {
    if (!this.copiedBuffer) return;
    const coords = this.selection ? { x: this.selection.x, y: this.selection.y } : { x: 5, y: 5 }; // default top left
    
    this.beginAction();
    this.pasteSelectionDirect(coords);
    this.commitAction();
    
    this.draw();
  }

  pasteSelectionDirect(coords) {
    const { w, h, layers } = this.copiedBuffer;
    for (let l = 0; l < 3; l++) {
      for (let bx = 0; bx < w; bx++) {
        for (let by = 0; by < h; by++) {
          const tx = coords.x + bx;
          const ty = coords.y + by;
          if (tx >= 0 && tx < this.width && ty >= 0 && ty < this.height) {
            this.setBlock(tx, ty, l, layers[l][bx][by]);
          }
        }
      }
    }
    // Move selection marquee to pasted position
    this.setSelection(coords.x, coords.y, w, h);
  }

  flipSelection(horizontal = true) {
    if (!this.selection) return;
    this.ensureSelectionCaptured();
    
    this.beginAction();
    // 1. Clear previous canvas selection area first
    this.clearCanvasSelectionArea();
    
    // 2. Perform flip on buffer
    const { w, h, layers } = this.copiedBuffer;
    const newLayers = [
      Array.from({ length: w }, () => Array.from({ length: h }, () => null)),
      Array.from({ length: w }, () => Array.from({ length: h }, () => null)),
      Array.from({ length: w }, () => Array.from({ length: h }, () => null))
    ];

    for (let l = 0; l < 3; l++) {
      for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) {
          const srcX = horizontal ? (w - 1 - x) : x;
          const srcY = horizontal ? y : (h - 1 - y);
          newLayers[l][x][y] = layers[l][srcX][srcY];
        }
      }
    }
    this.copiedBuffer.layers = newLayers;
    
    // 3. Paste the updated buffer at current coordinates
    const coords = { x: this.selection.x, y: this.selection.y };
    this.pasteSelectionDirect(coords);
    this.commitAction();
    this.draw();
  }

  rotateSelection(clockwise = true) {
    if (!this.selection) return;
    this.ensureSelectionCaptured();
    
    this.beginAction();
    // 1. Clear previous canvas selection area first
    this.clearCanvasSelectionArea();
    
    // 2. Perform rotation on buffer
    const { w, h, layers } = this.copiedBuffer;
    const newW = h;
    const newH = w;

    const newLayers = [
      Array.from({ length: newW }, () => Array.from({ length: newH }, () => null)),
      Array.from({ length: newW }, () => Array.from({ length: newH }, () => null)),
      Array.from({ length: newW }, () => Array.from({ length: newH }, () => null))
    ];

    for (let l = 0; l < 3; l++) {
      for (let x = 0; x < newW; x++) {
        for (let y = 0; y < newH; y++) {
          const srcX = clockwise ? y : (w - 1 - y);
          const srcY = clockwise ? (h - 1 - x) : x;
          newLayers[l][x][y] = layers[l][srcX][srcY];
        }
      }
    }

    this.copiedBuffer = { w: newW, h: newH, layers: newLayers };
    
    // 3. Paste the updated buffer at current coordinates
    const coords = { x: this.selection.x, y: this.selection.y };
    this.pasteSelectionDirect(coords);
    this.commitAction();
    this.draw();
  }

  // Undo/Redo Action Tracing
  beginAction() {
    this.currentActionChanges = [];
  }

  commitAction() {
    if (this.currentActionChanges.length === 0) return;
    
    this.pushHistory({
      type: 'draw',
      changes: this.currentActionChanges
    });
    this.currentActionChanges = [];
    this.updateMinimap();
  }

  pushHistory(action) {
    this.undoStack.push(action);
    this.redoStack = []; // clear redo on new action
    this.updateUndoRedoButtons();
  }

  undo() {
    if (this.undoStack.length === 0) return;
    const action = this.undoStack.pop();
    this.redoStack.push(action);

    if (action.type === 'draw') {
      // Revert in reverse order
      for (let i = action.changes.length - 1; i >= 0; i--) {
        const c = action.changes[i];
        this.setBlockDirect(c.x, c.y, c.layer, c.oldBlock);
      }
    } else if (action.type === 'resize') {
      this.width = action.oldW;
      this.height = action.oldH;
      this.layers = action.oldLayers;
      this.labels = action.oldLabels;
      this.updateCanvasSize();
    }

    this.updateUndoRedoButtons();
    this.clearSelection();
    this.draw();
    this.updateMinimap();
  }

  redo() {
    if (this.redoStack.length === 0) return;
    const action = this.redoStack.pop();
    this.undoStack.push(action);

    if (action.type === 'draw') {
      // Apply forward
      for (let i = 0; i < action.changes.length; i++) {
        const c = action.changes[i];
        this.setBlockDirect(c.x, c.y, c.layer, c.newBlock);
      }
    } else if (action.type === 'resize') {
      this.width = action.newW;
      this.height = action.newH;
      this.layers = action.newLayers;
      this.labels = action.newLabels;
      this.updateCanvasSize();
    }

    this.updateUndoRedoButtons();
    this.clearSelection();
    this.draw();
    this.updateMinimap();
  }

  updateUndoRedoButtons() {
    document.getElementById('btn-undo').disabled = this.undoStack.length === 0;
    document.getElementById('btn-redo').disabled = this.redoStack.length === 0;
  }

  // Main Drawing Loop
  draw() {
    // 1. Draw Background Colors
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    
    if (this.useWorldColors && this.meta && this.meta.backgroundColor) {
      this.ctx.fillStyle = argbToRgba(this.meta.backgroundColor);
    } else {
      this.ctx.fillStyle = '#0b0f19'; // fallback dark grey
    }
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Calculate viewport bounds to optimize rendering loops (100x speedup in larger worlds!)
    const parentW = this.container.clientWidth;
    const parentH = this.container.clientHeight;
    const startX = Math.max(0, Math.floor(-this.panX / this.zoom));
    const endX = Math.min(this.width - 1, Math.ceil((-this.panX + parentW) / this.zoom));
    const startY = Math.max(0, Math.floor(-this.panY / this.zoom));
    const endY = Math.min(this.height - 1, Math.ceil((-this.panY + parentH) / this.zoom));

    // 2. Interleaved Layer Blocks & Text Labels Rendering Loop
    // renderLayer spec: 0 = above background, 1 = above foreground, 2 = above player, 3+ = above overlay
    
    // Stage 0: Background Layer (0)
    if (this.layerVisibility[0]) {
      this.drawLayerGridCells(0, startX, endX, startY, endY);
    }
    this.drawTextLabelsForLayer(0, startX, endX, startY, endY);

    // Stage 1: Foreground Layer (1)
    if (this.layerVisibility[1]) {
      this.drawLayerGridCells(1, startX, endX, startY, endY);
    }
    this.drawTextLabelsForLayer(1, startX, endX, startY, endY);

    // Stage 2: Selection Drag Preview & Player Layer (above player)
    if (this.isDraggingSelection && this.selectionDragBuffer) {
      const { x, y, w, h } = this.selection;
      const { layers } = this.selectionDragBuffer;
      for (let l = 0; l < 3; l++) {
        if (!this.layerVisibility[l]) continue;
        for (let bx = 0; bx < w; bx++) {
          for (let by = 0; by < h; by++) {
            const tx = x + bx;
            const ty = y + by;
            if (tx >= startX && tx <= endX && ty >= startY && ty <= endY) {
              const block = layers[l][bx][by];
              if (block && block.id !== 0) {
                this.drawBlockCell(tx, ty, block);
              }
            }
          }
        }
      }
    }
    this.drawTextLabelsForLayer(2, startX, endX, startY, endY);

    // Stage 3: Overlay Layer (2)
    if (this.layerVisibility[2]) {
      this.drawLayerGridCells(2, startX, endX, startY, endY);
    }
    this.drawTextLabelsForLayer(3, startX, endX, startY, endY);

    // 3. Draw Grid Overlay
    if (this.showGrid && this.zoom >= 8) {
      this.drawGridLines();
    }

    // 4. Draw Shape Previews
    if (this.shapeStart && this.shapeEnd) {
      this.drawShapePreview();
    }

    // 5. Draw Label Bounding Box Highlights & Badges
    this.drawLabelBoundingBoxes();
  }

  getLabelBounds(lbl) {
    const fontScale = this.zoom / 16;
    const drawX = lbl.x * fontScale;
    const drawY = lbl.y * fontScale;

    const baseFontSize = (lbl.fontSize && lbl.fontSize > 0) ? lbl.fontSize : 12;
    const fontSizePx = Math.max(4, Math.round(baseFontSize * fontScale));

    const lines = String(lbl.text || '').split('\n');
    const extraLineSpacing = (lbl.lineSpacing !== undefined && lbl.lineSpacing !== null) ? (lbl.lineSpacing * fontScale) : 0;
    const lineHeight = Math.max(fontSizePx, fontSizePx + extraLineSpacing);
    const totalHeight = lines.length * lineHeight;

    let maxW = (lbl.maxWidth && lbl.maxWidth > 0) ? (lbl.maxWidth * fontScale) : 0;
    if (!maxW) {
      this.ctx.save();
      this.ctx.font = `${fontSizePx}px "NokiaFC22", sans-serif`;
      lines.forEach(line => {
        const w = this.ctx.measureText(line).width;
        if (w > maxW) maxW = w;
      });
      this.ctx.restore();
    }
    const boxW = Math.max(16 * fontScale, maxW);
    const boxH = Math.max(16 * fontScale, totalHeight);

    return {
      boxX: drawX,
      boxY: drawY,
      boxW: boxW,
      boxH: boxH,
      tileX: Math.floor(lbl.x / 16),
      tileY: Math.floor(lbl.y / 16)
    };
  }

  drawLabelBoundingBoxes() {
    if (!this.labels || this.labels.length === 0) return;

    const isLabelTool = this.activeToolId === 'label';

    this.ctx.save();

    for (const lbl of this.labels) {
      if (!lbl) continue;
      const bounds = this.getLabelBounds(lbl);
      const isSelected = this.selectedLabel === lbl;
      const isHovered = this.hoveredLabel === lbl;

      if (!isLabelTool && !isSelected && !isHovered) continue;

      // 1. Draw bounding box rectangle
      this.ctx.lineWidth = isSelected ? 2 : (isHovered ? 2 : 1);
      
      if (isSelected) {
        this.ctx.strokeStyle = '#f59e0b'; // Gold for selected
        this.ctx.fillStyle = 'rgba(245, 158, 11, 0.18)';
        this.ctx.setLineDash([]);
      } else if (isHovered) {
        this.ctx.strokeStyle = '#06b6d4'; // Bright Cyan for hovered
        this.ctx.fillStyle = 'rgba(6, 182, 212, 0.18)';
        this.ctx.setLineDash([4, 4]);
      } else {
        this.ctx.strokeStyle = 'rgba(6, 182, 212, 0.6)';
        this.ctx.fillStyle = 'rgba(6, 182, 212, 0.05)';
        this.ctx.setLineDash([3, 3]);
      }

      this.ctx.fillRect(bounds.boxX, bounds.boxY, bounds.boxW, bounds.boxH);
      this.ctx.strokeRect(bounds.boxX, bounds.boxY, bounds.boxW, bounds.boxH);

      // 2. Draw Top-Left Origin Anchor Point Dot
      this.ctx.setLineDash([]);
      this.ctx.fillStyle = isSelected ? '#f59e0b' : (isHovered ? '#06b6d4' : '#3b82f6');
      this.ctx.beginPath();
      this.ctx.arc(bounds.boxX, bounds.boxY, 4, 0, Math.PI * 2);
      this.ctx.fill();

      // 3. Draw Info Badge
      if (isSelected || isHovered || (isLabelTool && this.zoom >= 12)) {
        const fontScale = this.zoom / 16;
        const alignStr = (lbl.textAlignment === 1 || lbl.textAlignment === 'CENTER') ? 'CENTER' : ((lbl.textAlignment === 2 || lbl.textAlignment === 'RIGHT') ? 'RIGHT' : 'LEFT');
        const badgeText = `Label (${bounds.tileX}, ${bounds.tileY}) | ${alignStr}`;
        this.ctx.font = `${Math.max(10, Math.round(11 * fontScale))}px sans-serif`;
        this.ctx.textBaseline = 'bottom';
        this.ctx.textAlign = 'left';

        const textMetrics = this.ctx.measureText(badgeText);
        const badgeW = textMetrics.width + 8;
        const badgeH = 16;
        const badgeX = bounds.boxX;
        const badgeY = bounds.boxY - 4;

        this.ctx.fillStyle = isSelected ? '#78350f' : '#0f172a';
        this.ctx.fillRect(badgeX, badgeY - badgeH, badgeW, badgeH);
        this.ctx.strokeStyle = isSelected ? '#f59e0b' : '#06b6d4';
        this.ctx.strokeRect(badgeX, badgeY - badgeH, badgeW, badgeH);

        this.ctx.fillStyle = '#ffffff';
        this.ctx.fillText(badgeText, badgeX + 4, badgeY - 2);
      }
    }

    this.ctx.restore();
  }

  drawLayerGridCells(layerIndex, startX, endX, startY, endY) {
    const grid = this.layers[layerIndex];
    for (let x = startX; x <= endX; x++) {
      for (let y = startY; y <= endY; y++) {
        const block = grid[x][y];
        if (!block || block.id === 0) continue;
        this.drawBlockCell(x, y, block);
      }
    }
  }

  drawTextLabelsForLayer(layerStage, startX, endX, startY, endY) {
    if (!this.labels || this.labels.length === 0) return;

    this.ctx.save();

    for (const lbl of this.labels) {
      if (!lbl || lbl.text === undefined || lbl.text === null || String(lbl.text).trim() === '') continue;

      // Convert pixel position to tile position for bounds checking
      // (lbl.x and lbl.y are pixel coordinates in PixelWalker where 1 tile = 16 pixels)
      const tileX = lbl.x / 16;
      const tileY = lbl.y / 16;

      // Bounds checking (with margin for large font sizes / wide labels)
      if (tileX < startX - 30 || tileX > endX + 30 || tileY < startY - 30 || tileY > endY + 30) continue;

      let lblRenderLayer = 1;
      if (typeof lbl.renderLayer === 'number') {
        lblRenderLayer = lbl.renderLayer;
      } else if (typeof lbl.renderLayer === 'string') {
        const parsed = parseInt(lbl.renderLayer, 10);
        if (!isNaN(parsed)) lblRenderLayer = parsed;
      }

      // Filter by layerStage (0=above bg, 1=above fg, 2=above player, 3=above overlay)
      if (layerStage === 0 && lblRenderLayer !== 0) continue;
      if (layerStage === 1 && lblRenderLayer !== 1) continue;
      if (layerStage === 2 && lblRenderLayer !== 2) continue;
      if (layerStage === 3 && lblRenderLayer < 3) continue;

      // Scale pixel coordinates according to current camera zoom
      const fontScale = this.zoom / 16;
      const drawX = lbl.x * fontScale;
      const drawY = lbl.y * fontScale;

      const baseFontSize = (lbl.fontSize && lbl.fontSize > 0) ? lbl.fontSize : 12;
      const fontSizePx = Math.max(4, Math.round(baseFontSize * fontScale));

      this.ctx.font = `${fontSizePx}px "NokiaFC22", sans-serif`;
      this.ctx.textBaseline = 'top';

      // Alignment: LEFT (0), CENTER (1), RIGHT (2)
      let alignMode = 'left';
      const alignVal = lbl.textAlignment;
      if (alignVal === 1 || alignVal === 'CENTER' || alignVal === 'center') {
        alignMode = 'center';
      } else if (alignVal === 2 || alignVal === 'RIGHT' || alignVal === 'right') {
        alignMode = 'right';
      }
      this.ctx.textAlign = alignMode;

      // Letter Spacing (Character Spacing)
      if ('letterSpacing' in this.ctx) {
        if (lbl.characterSpacing) {
          this.ctx.letterSpacing = `${lbl.characterSpacing * fontScale}px`;
        } else {
          this.ctx.letterSpacing = '0px';
        }
      }

      const lines = String(lbl.text).split('\n');
      const extraLineSpacing = (lbl.lineSpacing !== undefined && lbl.lineSpacing !== null) ? (lbl.lineSpacing * fontScale) : 0;
      const lineHeight = Math.max(fontSizePx, fontSizePx + extraLineSpacing);
      const hasMaxWidth = lbl.maxWidth && lbl.maxWidth > 0;
      const maxW = hasMaxWidth ? (lbl.maxWidth * fontScale) : undefined;

      // Calculate uniform overall box width across all lines in the label
      let overallBoxWidth = maxW;
      if (!overallBoxWidth) {
        let maxLineWidth = 0;
        lines.forEach(l => {
          const w = this.ctx.measureText(l).width;
          if (w > maxLineWidth) maxLineWidth = w;
        });
        overallBoxWidth = Math.max(16 * fontScale, maxLineWidth);
      }

      // Calculate uniform X anchor position for all lines in the label
      let labelXPos = drawX;
      if (alignMode === 'center') {
        labelXPos = drawX + (overallBoxWidth / 2);
      } else if (alignMode === 'right') {
        labelXPos = drawX + overallBoxWidth;
      } else {
        labelXPos = drawX;
      }

      lines.forEach((line, i) => {
        const lineY = drawY + (i * lineHeight);
        const xPos = labelXPos;

        // 1. Outline (Stroke)
        if (lbl.outline) {
          const outlineCol = (lbl.outlineColor !== undefined && lbl.outlineColor !== null) ? lbl.outlineColor : 0xFF000000;
          this.ctx.strokeStyle = argbToRgba(outlineCol);
          const strokeWidth = Math.max(1, (lbl.outlineWidth || 1) * fontScale);
          this.ctx.lineWidth = strokeWidth;
          if (hasMaxWidth) {
            this.ctx.strokeText(line, xPos, lineY, maxW);
          } else {
            this.ctx.strokeText(line, xPos, lineY);
          }
        }

        // 2. Shadow (Offset Fill)
        if (lbl.shadow) {
          const shadowCol = (lbl.shadowColor !== undefined && lbl.shadowColor !== null) ? lbl.shadowColor : 0xFF000000;
          this.ctx.fillStyle = argbToRgba(shadowCol);
          const offX = (lbl.shadowOffsetX !== undefined ? lbl.shadowOffsetX : 1) * fontScale;
          const offY = (lbl.shadowOffsetY !== undefined ? lbl.shadowOffsetY : 1) * fontScale;
          if (hasMaxWidth) {
            this.ctx.fillText(line, xPos + offX, lineY + offY, maxW);
          } else {
            this.ctx.fillText(line, xPos + offX, lineY + offY);
          }
        }

        // 3. Main Text Fill
        let textCol = lbl.color;
        if (textCol === undefined || textCol === null) {
          textCol = 0xFFFFFFFF;
        }
        this.ctx.fillStyle = argbToRgba(textCol);
        if (hasMaxWidth) {
          this.ctx.fillText(line, xPos, lineY, maxW);
        } else {
          this.ctx.fillText(line, xPos, lineY);
        }
      });
    }

    if ('letterSpacing' in this.ctx) {
      this.ctx.letterSpacing = '0px';
    }
    this.ctx.restore();
  }

  drawBlockCell(x, y, block) {
    let meta = this.blocksById.get(block.id);
    if (block.id === 0) {
      meta = { PaletteId: 'empty_block', Layer: 1, MinimapColor: 0 };
    }
    const drawX = x * this.zoom;
    const drawY = y * this.zoom;

    // Retrieve display color from blocks.json metadata as fallback
    let fallbackColor = '#475569';
    if (meta) {
      if (meta.MinimapColor) {
        fallbackColor = argbToRgba(meta.MinimapColor);
      } else {
        if (meta.Layer === 0) fallbackColor = '#1e293b';
        else if (meta.Layer === 2) fallbackColor = 'rgba(6, 182, 212, 0.4)';
      }
    }

    // Check for custom color fields (e.g. solid background color blocks)
    let customColor = null;
    if (block.fields && block.fields.color !== undefined) {
      customColor = argbToRgba(block.fields.color);
    }

    const isSolidColorBlock = customColor && meta && 
                              !meta.PaletteId.startsWith('border_') && 
                              !meta.PaletteId.startsWith('fog_') && 
                              meta.Layer !== 2;

    if (isSolidColorBlock) {
      this.ctx.fillStyle = customColor;
      this.ctx.fillRect(drawX, drawY, this.zoom, this.zoom);
    } else if (meta) {
      drawBlockSprite(this.ctx, drawX, drawY, this.zoom, this.zoom, meta.PaletteId, meta.Layer, customColor || fallbackColor);
    } else {
      this.ctx.fillStyle = customColor || fallbackColor;
      this.ctx.fillRect(drawX, drawY, this.zoom, this.zoom);
    }

    // Draw Atlas Number Overlays for special fields (with smart support for switches and double-ID portals)
    let topVal = null;
    let bottomVal = null;

    if (block.fields) {
      const numFields = [];
      for (const [k, v] of Object.entries(block.fields)) {
        if (k !== 'color' && typeof v === 'number') {
          numFields.push({ key: k, val: v });
        }
      }

      if (numFields.length > 0) {
        // Check for double-ID portals (have one key matching portal_id/id and another matching target_id/target)
        const hasPortalId = numFields.find(f => f.key.toLowerCase().includes('portal') || f.key.toLowerCase() === 'id');
        const hasTargetId = numFields.find(f => f.key.toLowerCase().includes('target'));

        if (hasPortalId && hasTargetId) {
          topVal = hasPortalId.val;
          bottomVal = hasTargetId.val;
        } else {
          // Find the best single ID/numeric field (priority list -> endsWith('id') -> any numeric field)
          const priorityKeys = ['target', 'id', 'coins', 'amount', 'switchid', 'switch_id', 'gateid', 'gate_id'];
          let matchedField = null;

          for (const pk of priorityKeys) {
            matchedField = numFields.find(f => f.key.toLowerCase() === pk);
            if (matchedField) break;
          }

          if (!matchedField) {
            matchedField = numFields.find(f => f.key.toLowerCase().endsWith('id'));
          }

          if (!matchedField) {
            matchedField = numFields[0];
          }

          if (matchedField) {
            bottomVal = matchedField.val;
          }
        }
      }
    }

    const scale = Math.max(0.45, (this.zoom / 16) * 0.7);
    const margin = 1;

    if (topVal !== null) {
      const targetX = drawX + this.zoom - margin;
      const targetY = drawY + margin;
      drawAtlasNumber(this.ctx, targetX, targetY, scale, topVal);
    }

    if (bottomVal !== null) {
      const targetX = drawX + this.zoom - margin;
      const targetY = drawY + this.zoom - (7 * scale) - margin;
      drawAtlasNumber(this.ctx, targetX, targetY, scale, bottomVal);
    }
  }

  drawGridLines() {
    this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    this.ctx.lineWidth = 0.8;

    const parentW = this.container.clientWidth;
    const parentH = this.container.clientHeight;

    const startX = Math.max(0, Math.floor(-this.panX / this.zoom));
    const endX = Math.min(this.width, Math.ceil((-this.panX + parentW) / this.zoom));
    const startY = Math.max(0, Math.floor(-this.panY / this.zoom));
    const endY = Math.min(this.height, Math.ceil((-this.panY + parentH) / this.zoom));

    const minY = startY * this.zoom;
    const maxY = endY * this.zoom;
    const minX = startX * this.zoom;
    const maxX = endX * this.zoom;

    this.ctx.beginPath();
    // Vertical grid lines
    for (let x = startX; x <= endX; x++) {
      this.ctx.moveTo(x * this.zoom, minY);
      this.ctx.lineTo(x * this.zoom, maxY);
    }
    // Horizontal grid lines
    for (let y = startY; y <= endY; y++) {
      this.ctx.moveTo(minX, y * this.zoom);
      this.ctx.lineTo(maxX, y * this.zoom);
    }
    this.ctx.stroke();
  }

  drawPreviewBlockCell(x, y, block) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    let meta = this.blocksById.get(block.id);
    if (block.id === 0) {
      meta = { PaletteId: 'empty_block', Layer: 1, MinimapColor: 0 };
    }
    const drawX = x * this.zoom;
    const drawY = y * this.zoom;

    this.ctx.save();
    this.ctx.globalAlpha = 0.55; // Semi-transparent preview

    let fallbackColor = 'rgba(6, 182, 212, 0.4)';
    if (meta) {
      if (meta.MinimapColor) {
        fallbackColor = argbToRgba(meta.MinimapColor);
      } else {
        if (meta.Layer === 0) fallbackColor = '#1e293b';
        else if (meta.Layer === 2) fallbackColor = 'rgba(6, 182, 212, 0.4)';
      }
    }

    if (meta) {
      drawBlockSprite(this.ctx, drawX, drawY, this.zoom, this.zoom, meta.PaletteId, meta.Layer, fallbackColor);
    } else {
      this.ctx.fillStyle = fallbackColor;
      this.ctx.fillRect(drawX, drawY, this.zoom, this.zoom);
    }

    if (block.id === 0) {
      // Red outline for eraser/delete preview
      this.ctx.strokeStyle = '#ef4444';
      this.ctx.lineWidth = 1;
      this.ctx.strokeRect(drawX + 0.5, drawY + 0.5, this.zoom - 1, this.zoom - 1);
    }
    this.ctx.restore();
  }

  drawShapePreview() {
    if (!this.shapeStart || !this.shapeEnd) return;
    this.ctx.save();

    // Determine locked eraser layer at start coordinate if not locked yet
    if (this.activeBlock.id === 0 && this.autoRouteLayer && this.lockedEraserLayer === null) {
      const sx = this.shapeStart.x;
      const sy = this.shapeStart.y;
      let targetL = 1;
      if (this.layers[2][sx][sy].id !== 0) {
        targetL = 2;
      } else if (this.layers[1][sx][sy].id !== 0) {
        targetL = 1;
      } else if (this.layers[0][sx][sy].id !== 0) {
        targetL = 0;
      }
      this.lockedEraserLayer = targetL;
    }
    
    // Apply shift constraints dynamically
    let x1 = this.shapeStart.x;
    let y1 = this.shapeStart.y;
    let x2 = this.shapeEnd.x;
    let y2 = this.shapeEnd.y;

    if (this.isShiftHeld) {
      if (this.activeToolId === 'shape-line') {
        const dx = x2 - x1;
        const dy = y2 - y1;
        if (Math.abs(dx) > Math.abs(dy) * 1.5) {
          y2 = y1;
        } else if (Math.abs(dy) > Math.abs(dx) * 1.5) {
          x2 = x1;
        } else {
          const dist = Math.round((Math.abs(dx) + Math.abs(dy)) / 2);
          x2 = x1 + Math.sign(dx) * dist;
          y2 = y1 + Math.sign(dy) * dist;
        }
      } else {
        const size = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
        x2 = x1 + Math.sign(x2 - x1) * size;
        y2 = y1 + Math.sign(y2 - y1) * size;
      }
    }

    // 1. Draw Grid Placement Preview Blocks
    if (this.activeToolId === 'shape-line') {
      const dx = Math.abs(x2 - x1);
      const dy = Math.abs(y2 - y1);
      const sx = (x1 < x2) ? 1 : -1;
      const sy = (y1 < y2) ? 1 : -1;
      let err = dx - dy;
      let curX = x1, curY = y1;
      while (true) {
        this.drawPreviewBlockCell(curX, curY, this.activeBlock);
        if (curX === x2 && curY === y2) break;
        const e2 = 2 * err;
        if (e2 > -dy) {
          err -= dy;
          curX += sx;
        }
        if (e2 < dx) {
          err += dx;
          curY += sy;
        }
      }
    } else if (this.activeToolId === 'shape-rect') {
      const startX = Math.min(x1, x2);
      const endX = Math.max(x1, x2);
      const startY = Math.min(y1, y2);
      const endY = Math.max(y1, y2);
      for (let x = startX; x <= endX; x++) {
        for (let y = startY; y <= endY; y++) {
          if (this.shapeFill || x === startX || x === endX || y === startY || y === endY) {
            this.drawPreviewBlockCell(x, y, this.activeBlock);
          }
        }
      }
    } else if (this.activeToolId === 'shape-circle') {
      const minX = Math.min(x1, x2);
      const maxX = Math.max(x1, x2);
      const minY = Math.min(y1, y2);
      const maxY = Math.max(y1, y2);
      const rx = Math.abs(x2 - x1) / 2;
      const ry = Math.abs(y2 - y1) / 2;
      const cx = minX + rx;
      const cy = minY + ry;

      const isFilled = (x, y) => {
        if (rx === 0 && ry === 0) return x === Math.round(cx) && y === Math.round(cy);
        if (rx === 0) return x === Math.round(cx) && y >= minY && y <= maxY;
        if (ry === 0) return y === Math.round(cy) && x >= minX && x <= maxX;
        const termX = Math.pow(x - cx, 2) / Math.pow(rx, 2);
        const termY = Math.pow(y - cy, 2) / Math.pow(ry, 2);
        return (termX + termY) <= 1.05;
      };

      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          if (isFilled(x, y)) {
            if (this.shapeFill) {
              this.drawPreviewBlockCell(x, y, this.activeBlock);
            } else {
              const isBorder = 
                x === minX || x === maxX || y === minY || y === maxY ||
                !isFilled(x + 1, y) || !isFilled(x - 1, y) ||
                !isFilled(x, y + 1) || !isFilled(x, y - 1);
              
              if (isBorder) {
                this.drawPreviewBlockCell(x, y, this.activeBlock);
              }
            }
          }
        }
      }
    }

    // 2. Draw Vector Dashed Outline Overlays
    this.ctx.strokeStyle = this.activeToolId === 'select' ? 'rgba(6, 182, 212, 0.9)' : 'rgba(255, 255, 255, 0.4)';
    this.ctx.fillStyle = this.activeToolId === 'select' ? 'rgba(6, 182, 212, 0.08)' : 'rgba(255, 255, 255, 0.05)';
    this.ctx.lineWidth = 1.5;
    this.ctx.setLineDash([4, 4]);

    const px1 = x1 * this.zoom + this.zoom/2;
    const py1 = y1 * this.zoom + this.zoom/2;
    const px2 = x2 * this.zoom + this.zoom/2;
    const py2 = y2 * this.zoom + this.zoom/2;

    if (this.activeToolId === 'shape-line') {
      this.ctx.beginPath();
      this.ctx.moveTo(px1, py1);
      this.ctx.lineTo(px2, py2);
      this.ctx.stroke();
    } else if (this.activeToolId === 'shape-rect' || this.activeToolId === 'select') {
      const rx = Math.min(x1, x2) * this.zoom;
      const ry = Math.min(y1, y2) * this.zoom;
      const rw = (Math.abs(x2 - x1) + 1) * this.zoom;
      const rh = (Math.abs(y2 - y1) + 1) * this.zoom;
      this.ctx.strokeRect(rx, ry, rw, rh);
      this.ctx.fillRect(rx, ry, rw, rh);
    } else if (this.activeToolId === 'shape-circle') {
      const cx = (px1 + px2) / 2;
      const cy = (py1 + py2) / 2;
      const prx = Math.abs(px2 - px1) / 2;
      const pry = Math.abs(py2 - py1) / 2;
      this.ctx.beginPath();
      this.ctx.ellipse(cx, cy, prx, pry, 0, 0, Math.PI * 2);
      this.ctx.stroke();
      this.ctx.fill();
    }

    // 3. Update DOM selection marquee and size badge (high-contrast overlay)
    const bx = Math.min(x1, x2);
    const by = Math.min(y1, y2);
    const bw = Math.abs(x2 - x1) + 1;
    const bh = Math.abs(y2 - y1) + 1;

    const marquee = document.getElementById('selection-marquee');
    if (marquee) {
      const border = 1;
      marquee.style.left = `${bx * this.zoom - border}px`;
      marquee.style.top = `${by * this.zoom - border}px`;
      marquee.style.width = `${bw * this.zoom + border*2}px`;
      marquee.style.height = `${bh * this.zoom + border*2}px`;
      marquee.style.display = 'block';
    }
    const badge = document.getElementById('selection-size-badge');
    if (badge) {
      badge.textContent = `${bw} x ${bh}`;
    }

    this.ctx.restore();
  }

  // Update Minimap canvas (scaled to fit container, 1:1 pixel-perfect)
  updateMinimap() {
    const minCanvas = document.getElementById('minimap-canvas');
    if (!minCanvas) return;
    
    // Set internal resolution to match world dimensions exactly (removes dithering/blur!)
    if (minCanvas.width !== this.width || minCanvas.height !== this.height) {
      minCanvas.width = this.width;
      minCanvas.height = this.height;
    }

    // Set display size equal to raw block dimensions (times 1 or 2 zoom scale)
    const overlay = document.getElementById('minimap-panel') || document.querySelector('.minimap-overlay');
    const isX2 = overlay && overlay.classList.contains('x2');
    const scale = isX2 ? 2 : 1;
    
    const dispW = this.width * scale;
    const dispH = this.height * scale;
    minCanvas.style.width = `${dispW}px`;
    minCanvas.style.height = `${dispH}px`;
    
    const minCtx = minCanvas.getContext('2d');
    minCtx.clearRect(0, 0, this.width, this.height);
    
    // Fallback background color
    if (this.useWorldColors && this.meta && this.meta.backgroundColor) {
      minCtx.fillStyle = argbToRgba(this.meta.backgroundColor);
    } else {
      minCtx.fillStyle = '#000000';
    }
    minCtx.fillRect(0, 0, this.width, this.height);

    for (let x = 0; x < this.width; x++) {
      for (let y = 0; y < this.height; y++) {
        // Iterate top down (bg -> fg -> overlay) to find visible block color
        let color = null;
        for (let l = 2; l >= 0; l--) {
          if (!this.layerVisibility[l]) continue;
          const b = this.layers[l][x][y];
          if (b && b.id !== 0) {
            const meta = this.blocksById.get(b.id);
            if (meta && meta.MinimapColor) {
              color = argbToRgba(meta.MinimapColor);
              break;
            }
          }
        }
        
        if (color) {
          minCtx.fillStyle = color;
          minCtx.fillRect(x, y, 1, 1);
        }
      }
    }
  }
}
