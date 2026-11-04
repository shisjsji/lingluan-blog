// 神经元三维场景
// 性能要点：节点用 InstancedMesh 一次绘制，边用一个 LineSegments，
// 呼吸与漂移全部在 vertex shader 里完成，JS 每帧只更新几个 uniform。
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

const DARK = {
  bg: 0x07090d,
  nodeBase: new THREE.Color('#5f7482'),
  nodeWarm: new THREE.Color('#ffa07a'),
  nodeCool: new THREE.Color('#9fd0e4'),
  edge: new THREE.Color('#3f4e5a'),
  edgeWarm: new THREE.Color('#a85a40'),
  bloom: 0.42,
  bloomRadius: 0.8,
  bloomThreshold: 0.3,
  fog: 0.0075,
};

const LIGHT = {
  bg: 0xf2f5f6,
  nodeBase: new THREE.Color('#39434a'),
  nodeWarm: new THREE.Color('#b54b35'),
  nodeCool: new THREE.Color('#4f7382'),
  edge: new THREE.Color('#8e9ba2'),
  edgeWarm: new THREE.Color('#c07a66'),
  bloom: 0.22,
  bloomRadius: 0.5,
  bloomThreshold: 0.72,
  fog: 0.005,
};

function hashPhase(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000 * Math.PI * 2;
}

// 归一化哈希，用于把节点均匀铺在球面上
function unitHash(str, salt) {
  let h = 2166136261;
  const s = str + '#' + salt;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

export class NeuronScene {
  constructor(canvas, { onHover, onSelect } = {}) {
    this.canvas = canvas;
    this.onHover = onHover || (() => {});
    this.onSelect = onSelect || (() => {});
    this.dark = true;
    this.nodes = [];
    this.edges = [];
    this.visibleUntil = Infinity;
    this.hoveredUid = null;
    this.selectedUid = null;
    this.disposed = false;

    this.clock = new THREE.Clock();
    this.rotation = { x: 1.51, y: 0 };
    this.targetRotation = { x: 1.51, y: 0 };
    this.distance = 46;
    this.targetDistance = 46;
    this.dragging = false;
    this.lastPointer = { x: 0, y: 0 };
    this.pointerNDC = new THREE.Vector2(-10, -10);
    this.autoSpin = true;

    this._initRenderer();
    this._initScene();
    this._initEvents();
    this._animate();
  }

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // ACES 会把发光压暗，这里让颜色直出，靠 bloom 做光晕
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.resize();
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(DARK.bg);
    this.scene.fog = new THREE.FogExp2(DARK.bg, DARK.fog);

    this.camera = new THREE.PerspectiveCamera(48, 1, 0.1, 600);
    this.camera.position.set(0, 0, this.distance);

    // 光晕后处理
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), DARK.bloom, DARK.bloomRadius, DARK.bloomThreshold);
    this.composer.addPass(this.bloom);

    this.group = new THREE.Group();
    this.scene.add(this.group);

    this.uniforms = { uTime: { value: 0 }, uFocus: { value: new THREE.Vector3(0, 0, 0) }, uHover: { value: new THREE.Vector2(-1, -1) } };

    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Points.threshold = 2.4;

    this._buildStardust();
  }

  // 星系星尘：与神经元共用同一套旋臂骨架，让圆盘显得饱满
  _buildStardust() {
    const COUNT = 26000;
    const ARMS = 3;
    const SPIN = 0.75;
    const positions = new Float32Array(COUNT * 3);
    const sizes = new Float32Array(COUNT);
    const phases = new Float32Array(COUNT);
    const tints = new Float32Array(COUNT * 3);

    const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 0.9;

    for (let i = 0; i < COUNT; i += 1) {
      // 幂次让核区更密
      const t = Math.pow(Math.random(), 0.62);
      const radius = 2.5 + t * 30;

      const branch = Math.floor(Math.random() * ARMS) / ARMS;
      // 幂次抖动：八成贴着旋臂，两成散成星际尘埃
      const armJitter = Math.pow(Math.random(), 2.6) * (Math.random() < 0.5 ? 1 : -1) * 0.42;
      const r = radius + (Math.random() - 0.5) * 0.8;
      const angle = branch * Math.PI * 2 + r * SPIN + armJitter;

      positions[i * 3] = Math.cos(angle) * r;
      positions[i * 3 + 1] = gauss() * 2.2 * (1 - t * 0.78);
      positions[i * 3 + 2] = Math.sin(angle) * r;

      const bright = Math.random();
      sizes[i] = bright > 0.94 ? 1.3 + Math.random() * 1.2 : 0.22 + Math.random() * 0.6;
      phases[i] = Math.random() * Math.PI * 2;

      // 越靠中心越暖白，外围偏冷蓝
      const warm = Math.max(0, 1 - radius / 17);
      tints[i * 3] = 0.66 + warm * 0.32;
      tints[i * 3 + 1] = 0.74 + warm * 0.36;
      tints[i * 3 + 2] = 0.92 + warm * 0.06;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geom.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    geom.setAttribute('aTint', new THREE.BufferAttribute(tints, 3));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.uniforms.uTime,
        uColor: { value: new THREE.Color('#8fb8d4') },
        uOpacity: { value: 0.55 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
        uInvert: { value: 0 },
      },
      vertexShader: `
        attribute float aSize;
        attribute float aPhase;
        attribute vec3 aTint;
        uniform float uTime;
        uniform float uPixelRatio;
        varying float vTwinkle;
        varying vec3 vTint;
        void main() {
          float twinkle = 0.5 + 0.5 * sin(uTime * 0.8 + aPhase);
          vTwinkle = twinkle;
          vTint = aTint;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uPixelRatio * (150.0 / max(1.0, -mv.z)) * (0.75 + twinkle * 0.5);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uOpacity;
        uniform float uInvert;
        varying float vTwinkle;
        varying vec3 vTint;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          if (d > 0.5) discard;
          float a = smoothstep(0.5, 0.0, d) * vTwinkle * uOpacity;
          // 浅色模式下星点应是墨色的，不是发光的
          vec3 tinted = uInvert > 0.5 ? mix(uColor, vec3(0.1, 0.14, 0.17), 0.72) : uColor * vTint;
          gl_FragColor = vec4(tinted, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.stardust = new THREE.Points(geom, mat);
    this.stardust.frustumCulled = false;
    this.group.add(this.stardust);

    this._buildNebula();
    this._buildCore();
  }

  // 用 canvas 生成径向渐变贴图，避免引入外部资源
  _makeGlowTexture(inner, mid) {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, inner);
    g.addColorStop(0.4, mid);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // 星云层：几团大而淡的辉光，给星系体积感
  _buildNebula() {
    this.nebula = new THREE.Group();
    const layers = [
      { inner: 'rgba(126,98,214,0.5)', mid: 'rgba(74,52,150,0.16)', size: 165, pos: [0, 0, 0], op: 0.5 },
      { inner: 'rgba(84,126,200,0.42)', mid: 'rgba(40,74,138,0.13)', size: 120, pos: [34, -8, -26], op: 0.42 },
      { inner: 'rgba(150,120,215,0.22)', mid: 'rgba(92,64,150,0.08)', size: 112, pos: [-42, 10, 22], op: 0.26 },
    ];
    this.nebulaSprites = [];
    for (const layer of layers) {
      const mat = new THREE.SpriteMaterial({
        map: this._makeGlowTexture(layer.inner, layer.mid),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: layer.op,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(layer.size, layer.size, 1);
      sprite.position.set(...layer.pos);
      sprite.userData.baseOpacity = layer.op;
      this.nebula.add(sprite);
      this.nebulaSprites.push(sprite);
    }
    this.group.add(this.nebula);
  }

  // 星系核：中心那一点最亮的地方
  _buildCore() {
    const mat = new THREE.SpriteMaterial({
      map: this._makeGlowTexture('rgba(255,255,255,0.95)', 'rgba(214,198,255,0.42)'),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.6,
    });
    const core = new THREE.Sprite(mat);
    core.scale.set(13, 13, 1);
    this.group.add(core);
    this.core = core;
  }

  _initEvents() {
    const el = this.canvas;

    this._onPointerDown = (e) => {
      this.dragging = true;
      this.autoSpin = false;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      el.setPointerCapture?.(e.pointerId);
    };

    this._onPointerMove = (e) => {
      const rect = el.getBoundingClientRect();
      this.pointerNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointerNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      if (this.dragging) {
        const dx = e.clientX - this.lastPointer.x;
        const dy = e.clientY - this.lastPointer.y;
        this.targetRotation.y += dx * 0.005;
        this.targetRotation.x += dy * 0.004;
        this.targetRotation.x = Math.max(-1.2, Math.min(1.2, this.targetRotation.x));
        this.lastPointer = { x: e.clientX, y: e.clientY };
      }
    };

    this._onPointerUp = () => {
      this.dragging = false;
    };

    this._onWheel = (e) => {
      e.preventDefault();
      this.autoSpin = false;
      this.targetDistance = Math.max(28, Math.min(190, this.targetDistance + e.deltaY * 0.06));
    };

    this._onClick = () => {
      if (this.hoveredUid) {
        this.selectedUid = this.selectedUid === this.hoveredUid ? null : this.hoveredUid;
        this.onSelect(this.selectedUid);
      } else {
        this.selectedUid = null;
        this.onSelect(null);
      }
    };

    el.addEventListener('pointerdown', this._onPointerDown);
    el.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
    el.addEventListener('wheel', this._onWheel, { passive: false });
    el.addEventListener('click', this._onClick);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    this.renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
    this.bloom?.setSize(w, h);
    if (this.camera) this.camera.aspect = w / h;
    this.camera?.updateProjectionMatrix();
  }

  setTheme(dark) {
    this.dark = dark;
    const theme = dark ? DARK : LIGHT;
    this.scene.background = new THREE.Color(theme.bg);
    this.scene.fog = new THREE.FogExp2(theme.bg, theme.fog);
    // 浅色背景的亮度高于 bloom 阈值，开着泛光会把整片底衬糊成白色
    this.bloom.enabled = dark;
    this.bloom.strength = theme.bloom;
    this.bloom.radius = theme.bloomRadius;
    this.bloom.threshold = theme.bloomThreshold;
    this._applyColors();
  }

  _applyColors() {
    const theme = this.dark ? DARK : LIGHT;
    if (this.nodeMesh && this._nodeColors) {
      this.nodes.forEach((node, i) => {
        const c = this._nodeColor(node, theme);
        this._nodeColors[i * 3] = c.r;
        this._nodeColors[i * 3 + 1] = c.g;
        this._nodeColors[i * 3 + 2] = c.b;
      });
      this.nodeMesh.geometry.getAttribute('aColor').needsUpdate = true;
    }
    // 浅色纸面：星点必须是墨色的，靠混合模式和明暗反转实现
    const invert = this.dark ? 0 : 1;
    const blend = this.dark ? THREE.AdditiveBlending : THREE.NormalBlending;

    if (this.nodeMesh) {
      const u = this.nodeMesh.material.uniforms;
      u.uInvert.value = invert;
      this.nodeMesh.material.blending = blend;
      this.nodeMesh.material.needsUpdate = true;
    }

    if (this.stardust) {
      const u = this.stardust.material.uniforms;
      u.uColor.value.set(this.dark ? '#8fb8d4' : '#43515c');
      u.uOpacity.value = this.dark ? 0.55 : 0.52;
      u.uInvert.value = invert;
      this.stardust.material.blending = blend;
      this.stardust.material.needsUpdate = true;
    }

    // 发光核心在浅色纸面上会变成白雾，直接隐去，中心交给密集的星点
    if (this.core) {
      this.core.visible = this.dark;
      this.core.material.blending = blend;
      this.core.material.needsUpdate = true;
    }

    if (this.nebulaSprites) {
      for (const sprite of this.nebulaSprites) {
        sprite.material.opacity = this.dark ? sprite.userData.baseOpacity : sprite.userData.baseOpacity * 0.16;
        sprite.material.blending = blend;
        sprite.material.needsUpdate = true;
      }
    }
  }

  _nodeColor(node, theme) {
    const heat = node.heatRatio ?? 0.5;
    const c = theme.nodeBase.clone();
    c.lerp(theme.nodeCool, heat * 0.55);
    if (heat > 0.62) c.lerp(theme.nodeWarm, (heat - 0.62) / 0.38);
    return c;
  }

  setData(nodes, edges) {
    // 活跃度：越新的神经元越亮，按天指数衰减（50 天半衰期）
    const now = Date.now();
    this.nodes = nodes.slice();
    for (const node of this.nodes) {
      const days = (now - Date.parse(node.createdAt)) / 86400000;
      node.heatRatio = Math.exp(-Math.max(0, days) / 50);
    }

    // 半径按数据自身的时间跨度归一化
    const times = this.nodes.map((n) => Date.parse(n.createdAt));
    const minT = Math.min(...times);
    const maxT = Math.max(...times);
    const span = Math.max(1, maxT - minT);

    const ARMS = 3;
    const SPIN = 0.75;

    for (const node of this.nodes) {
      const t = (Date.parse(node.createdAt) - minT) / span;
      // 时间决定半径：早期记忆靠近星系核，新的在外圈
      const radius = 3 + Math.pow(t, 0.55) * 26;

      // 三条旋臂。角度抖动用幂次压缩：多数紧贴臂，少数散成雾
      const branch = Math.floor(unitHash(node.uid, 'branch') * ARMS) / ARMS;
      const armJitter = Math.pow(unitHash(node.uid, 'aj'), 2.6) * (unitHash(node.uid, 'as') < 0.5 ? 1 : -1) * 0.38;
      const rJitter = (unitHash(node.uid, 'rj') - 0.5) * 0.7;
      const r = radius + rJitter;
      const angle = branch * Math.PI * 2 + r * SPIN + armJitter;

      // 盘厚：中心厚、外缘薄
      const dy = (unitHash(node.uid, 'sy') - 0.5) * 3.2 * (1 - t * 0.7);

      node.pos = [Math.cos(angle) * r, dy, Math.sin(angle) * r];
    }

    this.timeSpan = { min: minT, max: maxT };
    this.edges = edges;
    this._buildNodes();
    this._applyColors();
    this.setTimeFilter(this.visibleUntil);
  }

  _buildNodes() {
    if (this.nodeMesh) {
      this.group.remove(this.nodeMesh);
      this.nodeMesh.geometry.dispose();
      this.nodeMesh.material.dispose();
      this.nodeMesh = null;
    }
    const count = this.nodes.length;
    if (!count) return;

    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const phases = new Float32Array(count);
    const visible = new Float32Array(count).fill(1);
    const colors = new Float32Array(count * 3);

    this.nodes.forEach((node, i) => {
      positions[i * 3] = node.pos[0];
      positions[i * 3 + 1] = node.pos[1];
      positions[i * 3 + 2] = node.pos[2];
      sizes[i] = 5.0 + node.weight * 3.6;
      phases[i] = hashPhase(node.uid);
      node._visible = 1;
    });

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geom.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    geom.setAttribute('aVisible', new THREE.BufferAttribute(visible, 1));
    geom.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.uniforms.uTime,
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
        uHoverIndex: { value: -1 },
        uInvert: { value: 0 },
      },
      vertexShader: `
        attribute float aSize;
        attribute float aPhase;
        attribute float aVisible;
        attribute vec3 aColor;
        uniform float uTime;
        uniform float uPixelRatio;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float pulse = 0.86 + 0.14 * sin(uTime * 1.15 + aPhase);
          gl_Position = projectionMatrix * mv;
          // 世界尺度换算到像素，深度越远越小
          gl_PointSize = aSize * uPixelRatio * pulse * aVisible * (46.0 / max(1.0, -mv.z));
          vColor = aColor;
          vAlpha = aVisible * (0.55 + 0.45 * pulse);
        }
      `,
      fragmentShader: `
        uniform float uInvert;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          if (d > 0.5) discard;
          float core = smoothstep(0.16, 0.0, d);
          float halo = smoothstep(0.5, 0.04, d);
          float a = (core * 1.0 + halo * 0.42) * vAlpha;
          // 深色模式核心提亮，浅色模式核心压深（白纸上叠白等于看不见）
          vec3 bright = vColor + core * 0.6;
          vec3 ink = mix(vColor * 1.15, vec3(0.04, 0.06, 0.08), core * 0.55);
          gl_FragColor = vec4(uInvert > 0.5 ? ink : bright, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const points = new THREE.Points(geom, mat);
    points.frustumCulled = false;
    points.userData.uidToIndex = new Map(this.nodes.map((n, i) => [n.uid, i]));
    this.group.add(points);
    this.nodeMesh = points;
    this._nodeColors = colors;
    this._nodeVisible = visible;
  }

  setTimeFilter(timestamp) {
    this.visibleUntil = timestamp;
    if (!this.nodeMesh || !this._nodeVisible) return;
    this.nodes.forEach((node, i) => {
      const visible = Date.parse(node.createdAt) <= timestamp ? 1 : 0;
      node._visible = visible;
      this._nodeVisible[i] = visible;
    });
    this.nodeMesh.geometry.getAttribute('aVisible').needsUpdate = true;
  }

  focusOn(uid) {
    const node = this.nodes.find((n) => n.uid === uid);
    if (!node) return;
    const target = new THREE.Vector3(node.pos[0], node.pos[1], node.pos[2]);
    this.targetRotation.y = Math.atan2(target.x, target.z);
    this.targetRotation.x = -Math.max(-0.9, Math.min(0.9, target.y / Math.max(1, target.length()) * 0.9));
    this.autoSpin = false;
    this.targetDistance = Math.max(34, Math.min(70, target.length() * 1.5));
  }

  resetView() {
    this.targetRotation = { x: 1.51, y: 0 };
    this.targetDistance = 46;
    this.autoSpin = true;
  }

  _animate = () => {
    if (this.disposed) return;
    this._raf = requestAnimationFrame(this._animate);
    const t = this.clock.getElapsedTime();
    this.uniforms.uTime.value = t;

    // 悬停检测，每两帧一次足够
    this._hoverTick = (this._hoverTick || 0) + 1;
    if (this._hoverTick % 2 === 0 && this.nodeMesh) {
      this.raycaster.setFromCamera(this.pointerNDC, this.camera);
      const hits = this.raycaster.intersectObject(this.nodeMesh, false);
      const nextUid = hits.length ? this.nodes[hits[0].instanceId]?.uid ?? null : null;
      if (nextUid !== this.hoveredUid) {
        this.hoveredUid = nextUid;
        const node = nextUid ? this.nodes.find((n) => n.uid === nextUid) : null;
        this.onHover(node || null);
      }
    }

    if (this.autoSpin) this.targetRotation.y += 0.0009;
    this.rotation.x += (this.targetRotation.x - this.rotation.x) * 0.06;
    this.rotation.y += (this.targetRotation.y - this.rotation.y) * 0.06;
    this.distance += (this.targetDistance - this.distance) * 0.08;

    this.group.rotation.x = this.rotation.x;
    this.group.rotation.y = this.rotation.y;
    this.camera.position.set(0, 0, this.distance);
    this.camera.lookAt(0, 0, 0);

    this.composer.render();
  };

  getFps() {
    return 0;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this._raf);
    const el = this.canvas;
    el.removeEventListener('pointerdown', this._onPointerDown);
    el.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    el.removeEventListener('wheel', this._onWheel);
    el.removeEventListener('click', this._onClick);
    this.nodeMesh?.geometry.dispose();
    this.nodeMesh?.material.dispose();
    this.stardust?.geometry.dispose();
    this.stardust?.material.dispose();
    // 星云与星系核持有 canvas 纹理，不释放会在反复切项目时持续占用显存
    if (this.nebulaSprites) {
      for (const sprite of this.nebulaSprites) {
        sprite.material.map?.dispose();
        sprite.material.dispose();
      }
      this.nebulaSprites = null;
    }
    if (this.core) {
      this.core.material.map?.dispose();
      this.core.material.dispose();
      this.core = null;
    }
    this.composer?.dispose?.();
    this.renderer?.dispose?.();
  }
}