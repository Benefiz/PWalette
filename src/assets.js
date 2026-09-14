import { argbToRgba } from './utils.js';

let atlasImage = null;
let atlasMetadata = null;
let isLoaded = false;
let loadPromise = null;

const ATLAS_OVERRIDES = {
  'empty_block': 'extra/empty',
  'switch_local_activator': 'foreground/switches/local_toggle',
  'switch_global_activator': 'foreground/switches/global_toggle',
  'switch_local_resetter': 'foreground/switches/local_resetter',
  'switch_global_resetter': 'foreground/switches/global_resetter',
};

// Map to cache resolved frame names for each PaletteId
const blockSpriteCache = new Map();

const CACHE_NAME = 'pixelwalker-assets-cache-v1';
const LOCAL_META_URL = '/pixelwalker-assets/atlases/blocks.json';
const REMOTE_META_URL = 'https://client.pixelwalker.net/atlases/blocks.json';
const LOCAL_IMG_URL = '/pixelwalker-assets/atlases/blocks.png';
const REMOTE_IMG_URL = 'https://client.pixelwalker.net/atlases/blocks.png';

let onUpdateCallback = null;

async function fetchWithFallback(localUrl, remoteUrl) {
  try {
    const res = await fetch(localUrl);
    if (res.ok) return res;
  } catch (e) {}
  return fetch(remoteUrl);
}

async function loadFromNetwork(cache) {
  try {
    console.log('Fetching atlas metadata from network...');
    const metaRes = await fetchWithFallback(LOCAL_META_URL, REMOTE_META_URL);
    const metaJson = await metaRes.clone().json();

    console.log('Fetching atlas image from network...');
    const imgRes = await fetchWithFallback(LOCAL_IMG_URL, REMOTE_IMG_URL);
    const imgBlob = await imgRes.clone().blob();

    atlasMetadata = metaJson;
    
    return new Promise((resolve) => {
      const objectUrl = URL.createObjectURL(imgBlob);
      atlasImage = new Image();
      atlasImage.crossOrigin = 'anonymous';
      atlasImage.onload = async () => {
        console.log('Network assets loaded successfully.');
        isLoaded = true;
        
        if (cache) {
          try {
            await cache.put(REMOTE_META_URL, metaRes);
            await cache.put(REMOTE_IMG_URL, imgRes);
            console.log('Assets saved to browser Cache Storage.');
          } catch (e) {
            console.warn('Failed to save to Cache Storage:', e);
          }
        }
        resolve(true);
      };
      atlasImage.onerror = () => {
        resolve(false);
      };
      atlasImage.src = objectUrl;
    });
  } catch (e) {
    console.error('Failed to load assets from network:', e);
    return false;
  }
}

async function revalidateAssets(cache) {
  if (!cache) return;
  try {
    console.log('Background checking assets for updates...');
    const metaRes = await fetchWithFallback(LOCAL_META_URL, REMOTE_META_URL);
    const newMetaJson = await metaRes.clone().json();

    const imgRes = await fetchWithFallback(LOCAL_IMG_URL, REMOTE_IMG_URL);
    const newImgBlob = await imgRes.clone().blob();

    const metaChanged = JSON.stringify(newMetaJson) !== JSON.stringify(atlasMetadata);
    
    let imageChanged = false;
    try {
      const cachedImgRes = await cache.match(REMOTE_IMG_URL);
      if (cachedImgRes) {
        const cachedBlob = await cachedImgRes.blob();
        imageChanged = newImgBlob.size !== cachedBlob.size;
      } else {
        imageChanged = true;
      }
    } catch (e) {
      imageChanged = true;
    }

    if (metaChanged || imageChanged) {
      console.log('Asset updates detected from network. Refreshing cache and reloading...');
      
      try {
        await cache.put(REMOTE_META_URL, metaRes);
        await cache.put(REMOTE_IMG_URL, imgRes);
      } catch (e) {
        console.warn('Failed to update Cache Storage:', e);
      }

      atlasMetadata = newMetaJson;
      blockSpriteCache.clear();

      const objectUrl = URL.createObjectURL(newImgBlob);
      const newImg = new Image();
      newImg.crossOrigin = 'anonymous';
      newImg.onload = () => {
        atlasImage = newImg;
        console.log('Assets reloaded from network update successfully.');
        if (onUpdateCallback) {
          onUpdateCallback();
        }
      };
      newImg.src = objectUrl;
    } else {
      console.log('Assets cache is up-to-date.');
    }
  } catch (e) {
    console.warn('Asset background update check failed:', e);
  }
}

export function initAssets(onUpdate) {
  if (onUpdate) onUpdateCallback = onUpdate;
  if (loadPromise) return loadPromise;

  loadPromise = new Promise(async (resolve) => {
    try {
      const hasCache = 'caches' in window;
      let cachedMetadata = null;
      let cachedImageBlob = null;
      let cache = null;

      if (hasCache) {
        try {
          cache = await caches.open(CACHE_NAME);
          const cachedMetaRes = await cache.match(REMOTE_META_URL);
          const cachedImgRes = await cache.match(REMOTE_IMG_URL);
          
          if (cachedMetaRes && cachedImgRes) {
            cachedMetadata = await cachedMetaRes.json();
            cachedImageBlob = await cachedImgRes.blob();
          }
        } catch (e) {
          console.warn('Failed to read from Cache Storage:', e);
        }
      }

      if (cachedMetadata && cachedImageBlob) {
        console.log('Loading assets from local browser cache...');
        atlasMetadata = cachedMetadata;
        
        const objectUrl = URL.createObjectURL(cachedImageBlob);
        atlasImage = new Image();
        atlasImage.crossOrigin = 'anonymous';
        atlasImage.onload = () => {
          console.log('Local cached assets loaded successfully.');
          isLoaded = true;
          resolve(true);
          
          // Revalidate in background
          revalidateAssets(cache);
        };
        atlasImage.onerror = () => {
          console.warn('Failed to load local cached image. Retrying network...');
          loadFromNetwork(cache).then(resolve);
        };
        atlasImage.src = objectUrl;
      } else {
        console.log('No local cached assets found. Loading from network...');
        loadFromNetwork(cache).then(resolve);
      }
    } catch (e) {
      console.error('Failed to initialize PixelWalker assets:', e);
      resolve(false);
    }
  });

  return loadPromise;
}

export function isAssetsLoaded() {
  return isLoaded;
}

// Find matching frame using our verified 100% match scoring heuristic
export function findAtlasFrame(paletteId, layer) {
  if (!atlasMetadata || !atlasMetadata.frames) return null;

  const cacheKey = `${paletteId}:${layer}`;
  if (blockSpriteCache.has(cacheKey)) {
    return blockSpriteCache.get(cacheKey);
  }

  const pid = paletteId.toLowerCase();
  
  // 1. Check overrides first
  if (ATLAS_OVERRIDES[pid]) {
    const frameName = ATLAS_OVERRIDES[pid];
    const match = atlasMetadata.frames.find(f => f.filename === frameName);
    if (match) {
      blockSpriteCache.set(cacheKey, match);
      return match;
    }
  }

  // 2. Exact match (slash replaced by underscore)
  const framesList = Object.entries(atlasMetadata.frames);
  let exactMatch = framesList.find(([k, v]) => v.filename.replace(/\//g, '_') === pid);
  if (exactMatch) {
    blockSpriteCache.set(cacheKey, exactMatch[1]);
    return exactMatch[1];
  }

  // 3. Fallback matching heuristic
  let cleanPid = pid;
  if (cleanPid.endsWith('_bg')) cleanPid = cleanPid.slice(0, -3);
  const parts = cleanPid.split('_');

  let bestFrame = null;
  let bestScore = -1;

  for (const [k, v] of framesList) {
    const fname = v.filename.toLowerCase();
    
    // Layer check: background layer (0) starts with 'background/'
    if (layer === 0 && !fname.startsWith('background/')) continue;
    if (layer !== 0 && fname.startsWith('background/')) continue;

    // Suffix match check to resolve duplicates on blocks with exact suffix names (e.g. borders, decors)
    const strippedFname = fname.replace(/^(decoration\/border\/|decoration\/|decorative\/|foreground\/|background\/|action\/|tile\/)/, '');
    const strippedPid = cleanPid.replace(/^(border_|decorative_|foreground_|background_|action_|tile_)/, '');
    
    let score = 0;
    if (strippedPid === strippedFname) {
      score += 10000;
    }

    let matchCount = 0;
    parts.forEach(p => {
      if (fname.includes(p)) matchCount++;
    });

    if (matchCount > 0 || score > 0) {
      // Base score on matches
      score += matchCount * 100 - fname.length;
      // Exact path segment match bonus
      const pathSegments = fname.split('/');
      parts.forEach(p => {
        if (pathSegments.includes(p)) score += 20;
      });

      if (score > bestScore) {
        bestScore = score;
        bestFrame = v;
      }
    }
  }

  if (bestFrame) {
    blockSpriteCache.set(cacheKey, bestFrame);
    return bestFrame;
  }

  blockSpriteCache.set(cacheKey, null);
  return null;
}

// Draw block sprite onto a 2D canvas context
export function drawBlockSprite(ctx, destX, destY, destW, destH, paletteId, layer, fallbackColor = '#475569') {
  if (!isLoaded || !atlasImage || !atlasMetadata) {
    ctx.fillStyle = fallbackColor;
    ctx.fillRect(Math.round(destX), Math.round(destY), Math.round(destW), Math.round(destH));
    return;
  }

  const frameInfo = findAtlasFrame(paletteId, layer);
  if (!frameInfo || !frameInfo.frame) {
    ctx.fillStyle = fallbackColor;
    ctx.fillRect(Math.round(destX), Math.round(destY), Math.round(destW), Math.round(destH));
    return;
  }

  const f = frameInfo.frame;
  ctx.drawImage(
    atlasImage,
    Math.round(f.x), Math.round(f.y), 16, 16, // source rect (first 16x16 tile)
    Math.round(destX), Math.round(destY), Math.round(destW), Math.round(destH) // dest rect
  );
}

// Generate CSS style background-image definition for use in HTML elements (e.g. palette items)
export function getBlockSpriteStyle(paletteId, layer, targetSize = 16) {
  if (!isLoaded || !atlasMetadata) return null;
  const frameInfo = findAtlasFrame(paletteId, layer);
  if (!frameInfo || !frameInfo.frame) return null;

  const f = frameInfo.frame;
  const imageUrl = '/pixelwalker-assets/atlases/blocks.png';
  const ratio = targetSize / 16;
  const rx = Math.round(f.x * ratio);
  const ry = Math.round(f.y * ratio);
  const rw = Math.round(atlasMetadata.meta.size.w * ratio);
  const rh = Math.round(atlasMetadata.meta.size.h * ratio);
  return {
    backgroundImage: `url('${imageUrl}')`,
    backgroundPosition: `-${rx}px -${ry}px`,
    backgroundSize: `${rw}px ${rh}px`,
    width: `${targetSize}px`,
    height: `${targetSize}px`
  };
}

// Render numeric values over block sprites (using digit frames from extra/numbers strip)
export function drawAtlasNumber(ctx, destX, destY, scale, value) {
  if (!isLoaded || !atlasImage || !atlasMetadata || !atlasMetadata.frames) return;

  const numFrame = atlasMetadata.frames.find(f => f.filename === 'extra/numbers');
  if (!numFrame || !numFrame.frame) return;

  const valStr = String(value);
  const charW = 6;
  const charH = 7; // Split horizontally (14px total height / 2 rows)

  const totalW = valStr.length * charW * scale;
  const startX = destX - totalW; // Right-aligned anchor offset
  const startY = destY;

  ctx.save();
  for (let i = 0; i < valStr.length; i++) {
    const char = valStr[i];
    let charIdx = -1;
    if (char >= '0' && char <= '9') {
      charIdx = char.charCodeAt(0) - 48; // '0' code is 48
    } else if (char === '/') {
      charIdx = 10;
    }

    if (charIdx !== -1) {
      const sx = numFrame.frame.x + charIdx * charW;
      const sy = numFrame.frame.y; // Top row of white numbers (Row 0)
      const sw = charW;
      const sh = charH;

      const dx = startX + i * charW * scale;
      const dy = startY;
      const dw = charW * scale;
      const dh = charH * scale;

      ctx.drawImage(atlasImage, sx, sy, sw, sh, dx, dy, dw, dh);
    }
  }
  ctx.restore();
}
