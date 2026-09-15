# PWalette - PixelWalker Level Editor

**PWalette** is a responsive, feature-rich offline/online level editor for [PixelWalker](https://pixelwalker.net). Built as a high-performance Single-Page Application (SPA) using Vite, HTML5 Canvas, and Vanilla JS, PWalette gives builders complete creative control over level creation, block placement, multi-layer design, and live room synchronization.

---

## ✨ Features

- 🎨 **Multi-Layer 2D Tile Canvas:** Seamless editing across Background (0), Foreground (1), and Overlay (2) layers with real-time rendering, grid toggles, and minimap navigation.
- 🖌️ **Comprehensive Drawing Toolset:**
  - **Pencil (`P`) & Brush (`B`):** Variable brush size tile drawing.
  - **Bucket Fill (`F`):** Flood fill connected tile regions across active layers.
  - **Shapes (`R`, `C`, `L`):** Rectangle, Circle, and Line drawing preview modes.
  - **Marquee Selection (`S`) & Move (`M`):** Cut, copy, paste, drag, and clear tile selections with undo/redo history buffer.
  - **Inspect Tool (`I`):** Direct block inspection and property editing (signs, portals, doors, hazards).
  - **Find & Replace Tool:** Search blocks by ID or name with live autocomplete suggestions and bulk parameter replacement.
  - **Text Label Tool (`T`):** Interactive bounding box inspection, top-left anchor origin badges, and live property editing for `ProtoTextLabel` blocks using the official NokiaFC22 pixel font.
- 📁 **File Import & Export:**
  - Full support for **Pilot2 JSON level files**.
  - Local level backup and restore.
- 🌐 **Live Room Online Synchronization:**
  - Direct connection to PixelWalker game servers (`api.pixelwalker.net` / `server.pixelwalker.net`).
  - Read & Write live level sync using binary RLE Protobuf protocol (`WorldPackets`).
  - Secret edit key authentication for write-protected rooms.
  - Automatic `v2026.11.1` client version compatibility & ping heartbeat.
- ⌨️ **Hotbar & Keybindings:** 9 hotbar quick-slots, number keys `1-9` switching, and standard keyboard shortcuts.

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18.0.0 or higher recommended)
- `npm` or `yarn`

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Benefiz/pwalette.git
   cd pwalette
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Start the local development server:**
   ```bash
   npm run dev
   ```
   Open your browser and navigate to `http://localhost:3000/`.

---

## 📦 Building for Production

To create an optimized production build:

```bash
npm run build
```

The production output will be generated in the `dist/` directory, ready to be deployed to any static host (Vercel, Netlify, GitHub Pages, Cloudflare Pages, Nginx, S3, etc.).

To preview the production build locally:

```bash
npm run preview
```

---

## 🛠️ Tech Stack & Architecture

- **Frontend Core:** JavaScript (ES Modules), HTML5 Canvas 2D API.
- **Build Tooling:** [Vite](https://vitejs.dev/) v6.
- **Networking & Protocol:** [Protobuf.js](https://github.com/protobufjs/protobuf.js) (Google Protocol Buffers binary protocol for WebSocket stream decoding/encoding).
- **Typography & Aesthetics:** NokiaFC22 Pixel Font, Outfit, JetBrains Mono, CSS Glassmorphism & Modern Dark Theme.

---

## 📄 License

MIT License. Developed for the PixelWalker builder community.
