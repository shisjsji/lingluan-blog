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
  bloom: 0.62,
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
    this.rotation = { x: 0.18, y: 0 };
    this.targetRotation = { x: 0.18, y: 0 };
    this.distance = 78;
    this.targetDistance = 78;
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
    this.raycaster.params.Points.threshold = 1.2;

    this._buildStardust();
  }

  // 远景星尘：让背景不再是空的
  _buildStardust() {
    const COUNT = 1100;
    const positions = new Float32Array(COUNT * 3);
    const sizes = new Float32Array(COUNT);
    const phases = new Float32Array(COUNT);

    for (let i = 0; i < COUNT; i += 1) {
      const r = 58 + Math.random() * 96;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const sp = Math.sin(phi);
      positions[i * 3] = r * sp * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi) * 0.8;
      positions[i * 3 + 2] = r * sp * Math.sin(theta);
      sizes[i] = 0.5 + Math.random() * 1.8;
      phases[i] = Math.random() * Math.PI * 2;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geom.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.uniforms.uTime,
        uColor: { value: new THREE.Color('#8fb8d4') },
        uOpacity: { value: 0.55 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      },
      vertexShader: `
        attribute float aSize;
        attribute float aPhase;
        uniform float uTime;
        uniform float uPixelRatio;
        varying float vTwinkle;
        void main() {
          float twinkle = 0.45 + 0.55 * sin(uTime * 0.8 + aPhase);
          vTwinkle = twinkle;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uPixelRatio * (180.0 / -mv.z) * (0.7 + twinkle * 0.6);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vTwinkle;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          if (d > 0.5) discard;
          float a = smoothstep(0.5, 0.0, d) * vTwinkle * uOpacity;
          gl_FragColor = vec4(uColor, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.stardust = new THREE.Points(geom, mat);
    this.stardust.frustumCulled = false;
    this.scene.add(this.stardust);
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
    if (this.nodeMesh) {
      const colors = this.nodes.map((n) => this._nodeColor(n, theme));
      for (let i = 0; i < this.nodes.length; i += 1) this.nodeMesh.setColorAt(i, colors[i]);
      this.nodeMesh.instanceColor.needsUpdate = true;
    }
    if (this.lineMesh) {
      this.lineMesh.material.color.copy(theme.edge);
      this.lineMesh.material.opacity = this.dark ? 0.4 : 0.5;
    }
    if (this.warmLineMesh) {
      this.warmLineMesh.material.color.copy(theme.edgeWarm);
      this.warmLineMesh.material.opacity = this.dark ? 0.6 : 0.5;
    }
    if (this.sparkMesh) {
      const u = this.sparkMesh.material.uniforms;
      u.uColor.value.copy(this.dark ? theme.nodeCool : theme.nodeWarm);
      u.uOpacity.value = this.dark ? 0.9 : 0.34;
    }
    if (this.stardust) {
      const u = this.stardust.material.uniforms;
      u.uColor.value.copy(this.dark ? new THREE.Color('#8fb8d4') : new THREE.Color('#7d8b93'));
      u.uOpacity.value = this.dark ? 0.55 : 0.16;
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

    // 半径按数据自身的时间跨度归一化，否则跨度小时会挤成一团
    const times = this.nodes.map((n) => Date.parse(n.createdAt));
    const minT = Math.min(...times);
    const maxT = Math.max(...times);
    const span = Math.max(1, maxT - minT);
    for (const node of this.nodes) {
      const t = (Date.parse(node.createdAt) - minT) / span;
      const vol = Math.cbrt(unitHash(node.uid, 'r'));
      const r = 5 + vol * 22 + t * 12;

      // 方向由 uid 均匀铺开（同一项目内标签高度重复，若按标签聚类会全叠在一起）
      const u = unitHash(node.uid, 'u');
      const v = unitHash(node.uid, 'v');
      const theta = u * Math.PI * 2;
      const phi = Math.acos(2 * v - 1);

      // 同标签做一点点靠拢，保留簇感但不重叠
      const tagBias = unitHash((node.tags && node.tags[0]) || 'misc', 'b') * 0.35;
      const th = theta + (tagBias - 0.175) * 0.6;
      const sinPhi = Math.sin(phi);

      node.pos = [r * sinPhi * Math.cos(th), r * Math.cos(phi) * 0.82, r * sinPhi * Math.sin(th)];
    }

    this.timeSpan = { min: minT, max: maxT };
    this.edges = edges;
    this._buildNodes();
    this._buildEdges();
    this._buildSparks();
    this._applyColors();
    this.setTimeFilter(this.visibleUntil);
  }

  _buildNodes() {
    if (this.nodeMesh) {
      this.group.remove(this.nodeMesh);
      this.nodeMesh.geometry.dispose();
      this.nodeMesh.material.dispose();
    }
    const count = this.nodes.length;
    if (!count) return;

    const geom = new THREE.SphereGeometry(1, 14, 12);
    const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.98 });
    // 呼吸：在顶点着色器里按 instance 相位缩放，JS 不做逐节点计算
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uniforms.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPhase;\nuniform float uTime;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nfloat breathe = 1.0 + 0.16 * sin(uTime * 1.1 + aPhase);\ntransformed *= breathe;'
        );
    };

    const phases = new Float32Array(count);
    for (let i = 0; i < count; i += 1) phases[i] = hashPhase(this.nodes[i].uid);
    geom.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));

    const mesh = new THREE.InstancedMesh(geom, mat, count);
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    const matrix = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const pos = new THREE.Vector3();

    this.nodes.forEach((node, i) => {
      pos.set(node.pos[0], node.pos[1], node.pos[2]);
      const size = 0.24 + node.weight * 0.24;
      scale.setScalar(size);
      matrix.compose(pos, quat, scale);
      mesh.setMatrixAt(i, matrix);
      node._worldPos = pos.clone();
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.userData.uidToIndex = new Map(this.nodes.map((n, i) => [n.uid, i]));

    this.group.add(mesh);
    this.nodeMesh = mesh;
  }

  _buildEdges() {
    const lineGeoms = [];
    const positions = [];
    const byUid = new Map(this.nodes.map((n) => [n.uid, n]));

    for (const edge of this.edges) {
      const a = byUid.get(edge.source);
      const b = byUid.get(edge.target);
      if (!a || !b) continue;
      positions.push(a.pos[0], a.pos[1], a.pos[2], b.pos[0], b.pos[1], b.pos[2]);
      lineGeoms.push(edge);
    }

    if (this.lineMesh) {
      this.group.remove(this.lineMesh);
      this.lineMesh.geometry.dispose();
      this.lineMesh.material.dispose();
    }
    if (!positions.length) return;

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({ color: this.dark ? DARK.edge : LIGHT.edge, transparent: true, opacity: this.dark ? 0.4 : 0.5 });
    const lines = new THREE.LineSegments(geom, mat);
    lines.frustumCulled = false;
    this.group.add(lines);
    this.lineMesh = lines;
    this.warmLineMesh = null;
  }

  // 突触流光：光点沿连线移动，位置全在着色器里算，不占 CPU
  _buildSparks() {
    if (this.sparkMesh) {
      this.group.remove(this.sparkMesh);
      this.sparkMesh.geometry.dispose();
      this.sparkMesh.material.dispose();
      this.sparkMesh = null;
    }

    const byUid = new Map(this.nodes.map((n) => [n.uid, n]));
    const pairs = [];
    for (const edge of this.edges) {
      const a = byUid.get(edge.source);
      const b = byUid.get(edge.target);
      if (a && b) pairs.push([a, b]);
    }
    if (!pairs.length) return;

    const count = Math.min(360, Math.max(48, pairs.length));
    const start = new Float32Array(count * 3);
    const end = new Float32Array(count * 3);
    const phase = new Float32Array(count);
    const speed = new Float32Array(count);

    for (let i = 0; i < count; i += 1) {
      const [a, b] = pairs[Math.floor(Math.random() * pairs.length)];
      start.set(a.pos, i * 3);
      end.set(b.pos, i * 3);
      phase[i] = Math.random();
      speed[i] = 0.07 + Math.random() * 0.2;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(start.slice(), 3));
    geom.setAttribute('aStart', new THREE.BufferAttribute(start, 3));
    geom.setAttribute('aEnd', new THREE.BufferAttribute(end, 3));
    geom.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geom.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.uniforms.uTime,
        uColor: { value: new THREE.Color('#9fd0e4') },
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
        uSize: { value: 2.8 },
        uOpacity: { value: 0.9 },
      },
      vertexShader: `
        attribute vec3 aStart;
        attribute vec3 aEnd;
        attribute float aPhase;
        attribute float aSpeed;
        uniform float uTime;
        uniform float uPixelRatio;
        uniform float uSize;
        varying float vAlpha;
        void main() {
          float t = fract(uTime * aSpeed + aPhase);
          vec3 p = mix(aStart, aEnd, t);
          vAlpha = sin(t * 3.14159265);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uSize * uPixelRatio * (240.0 / -mv.z);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vAlpha;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          if (d > 0.5) discard;
          float a = smoothstep(0.5, 0.0, d) * vAlpha * uOpacity;
          gl_FragColor = vec4(uColor, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const sparks = new THREE.Points(geom, mat);
    sparks.frustumCulled = false;
    this.group.add(sparks);
    this.sparkMesh = sparks;
  }

  // 时间轴回放：只显示该时间点之前诞生的神经元
  setTimeFilter(timestamp) {
    this.visibleUntil = timestamp;
    if (!this.nodeMesh) return;
    const matrix = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const pos = new THREE.Vector3();

    this.nodes.forEach((node, i) => {
      const born = Date.parse(node.createdAt);
      const visible = born <= timestamp;
      pos.set(node.pos[0], node.pos[1], node.pos[2]);
      const size = visible ? 0.24 + node.weight * 0.24 : 0.0001;
      scale.setScalar(size);
      matrix.compose(pos, quat, scale);
      this.nodeMesh.setMatrixAt(i, matrix);
    });
    this.nodeMesh.instanceMatrix.needsUpdate = true;
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
    this.targetRotation = { x: 0.18, y: 0 };
    this.targetDistance = 78;
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
    this.lineMesh?.geometry.dispose();
    this.lineMesh?.material.dispose();
    this.sparkMesh?.geometry.dispose();
    this.sparkMesh?.material.dispose();
    this.stardust?.geometry.dispose();
    this.stardust?.material.dispose();
    this.composer?.dispose?.();
    this.renderer?.dispose?.();
  }
}