/**
 * 3D 场景:竹知了的立体模型(竹签、竹筒手柄、双叶竹片)、
 * 旋转残影/运动模糊、竹林背景、粒子与光照。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import {
  makeBambooTexture,
  makeBladeTexture,
  makeGroundTexture,
  makeDiscTexture,
  makeBladeShape,
} from './textures.js';
import { W_MAX } from './physics.js';

const BLADE_SPAN = 0.168; // 单片叶长
const BLADE_THICK = 0.003;

/** 残影参数:角滞后(rad)与基础透明度,按转速缩放。 */
const GHOST_DEFS = [
  { lag: 0.34, op: 0.30 },
  { lag: 0.55, op: 0.20 },
  { lag: 0.76, op: 0.13 },
  { lag: 1.0, op: 0.08 },
  { lag: 1.28, op: 0.05 },
];

export class Scene3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.isMobile = /Android|iPhone|iPad|Mobi/i.test(navigator.userAgent);
    this.time = 0;
    this.spinAngle = 0;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !this.isMobile,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.isMobile ? 1.75 : 2));
    this.renderer.shadowMap.enabled = !this.isMobile;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0xe9f3d6, 7, 16);

    this.camera = new THREE.PerspectiveCamera(44, 1, 0.1, 60);
    this.camera.position.set(0.72, 0.62, 1.45);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.42, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minDistance = 0.55;
    this.controls.maxDistance = 3.4;
    this.controls.minPolarAngle = 0.28;
    this.controls.maxPolarAngle = 1.42;
    this.controls.update();

    this._lights();
    this._ground();
    this._pedestal();
    this._stalks();
    this._toy();
    this._particles();
    this.resize();
  }

  _lights() {
    const hemi = new THREE.HemisphereLight(0xfff6d8, 0x4c6b3a, 1.15);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffe6b8, 2.1);
    sun.position.set(3.2, 5.5, 2.4);
    sun.castShadow = !this.isMobile;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -2.4;
    sun.shadow.camera.right = 2.4;
    sun.shadow.camera.top = 3;
    sun.shadow.camera.bottom = -2;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 14;
    sun.shadow.bias = -0.0006;
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0xdfecc8, 0.5));
  }

  _ground() {
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(7, 48),
      new THREE.MeshStandardMaterial({ map: makeGroundTexture(), roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = !this.isMobile;
    this.scene.add(ground);
  }

  _pedestal() {
    const g = new THREE.Group();
    const bamboo = makeBambooTexture(3);
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.17, 0.19, 0.035, 32),
      new THREE.MeshStandardMaterial({ map: bamboo, roughness: 0.7 })
    );
    base.position.y = 0.0175;
    base.receiveShadow = true;
    base.castShadow = true;
    g.add(base);
    const column = new THREE.Mesh(
      new THREE.CylinderGeometry(0.048, 0.062, 0.44, 24),
      new THREE.MeshStandardMaterial({ map: bamboo, roughness: 0.66 })
    );
    column.position.y = 0.255;
    column.castShadow = true;
    column.receiveShadow = true;
    g.add(column);
    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(0.075, 0.055, 0.03, 24),
      new THREE.MeshStandardMaterial({ color: 0xd9bd7e, roughness: 0.6 })
    );
    cap.position.y = 0.485;
    cap.castShadow = true;
    g.add(cap);
    this.scene.add(g);
    this.pedestal = g;
  }

  _stalks() {
    const bamboo = makeBambooTexture(7);
    const leafMat = new THREE.MeshStandardMaterial({
      color: 0x5f9c45,
      roughness: 0.8,
      side: THREE.DoubleSide,
    });
    const leafGeo = new THREE.ShapeGeometry(leafShape());
    this.leaves = [];
    const spots = [
      { x: -2.3, z: -1.1, h: 3.1 },
      { x: 2.6, z: -1.7, h: 2.5 },
      { x: 1.7, z: 2.4, h: 3.5 },
      { x: -2.8, z: 2.0, h: 2.7 },
    ];
    for (const sp of spots) {
      const stalk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.026, 0.034, sp.h, 10),
        new THREE.MeshStandardMaterial({ map: bamboo, roughness: 0.7 })
      );
      stalk.position.set(sp.x, sp.h / 2, sp.z);
      stalk.rotation.z = (Math.random() - 0.5) * 0.05;
      this.scene.add(stalk);
      const nLeaves = 3 + Math.floor(Math.random() * 3);
      for (let i = 0; i < nLeaves; i++) {
        const leaf = new THREE.Mesh(leafGeo, leafMat);
        const a = (i / nLeaves) * Math.PI * 2 + Math.random();
        leaf.position.set(
          sp.x + Math.cos(a) * 0.12,
          sp.h * (0.55 + 0.35 * Math.random()),
          sp.z + Math.sin(a) * 0.12
        );
        leaf.rotation.set(Math.random() * 0.6, Math.random() * Math.PI, (Math.random() - 0.5) * 0.8);
        leaf.scale.setScalar(0.16 + Math.random() * 0.1);
        this.scene.add(leaf);
        this.leaves.push({ mesh: leaf, phase: Math.random() * Math.PI * 2, speed: 0.6 + Math.random() * 0.7 });
      }
    }
  }

  _toy() {
    this.toy = new THREE.Group();
    this.toy.position.y = 0.52;

    const bambooLight = makeBambooTexture(5);
    const bambooDark = makeBambooTexture(9);

    // 手柄:竹筒(固定不动,现实中由一只手握着)
    const handleMat = new THREE.MeshStandardMaterial({ map: bambooDark, roughness: 0.58 });
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.155, 28, 1, true), handleMat);
    handle.position.y = 0.028;
    handle.castShadow = true;
    handle.receiveShadow = true;
    this.toy.add(handle);
    for (const y of [-0.0495, 0.1055]) {
      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(0.034, 0.0045, 10, 28),
        new THREE.MeshStandardMaterial({ color: 0xb99858, roughness: 0.5 })
      );
      rim.position.y = y;
      rim.rotation.x = Math.PI / 2;
      this.toy.add(rim);
    }

    // 旋转部分:竹签 + 叶片
    this.spinGroup = new THREE.Group();
    const stick = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0072, 0.0072, 0.31, 10),
      new THREE.MeshStandardMaterial({ map: bambooLight, roughness: 0.55 })
    );
    stick.position.y = 0.1;
    stick.castShadow = true;
    this.spinGroup.add(stick);

    this.bladeGroup = new THREE.Group();
    this.bladeGroup.position.y = 0.242;
    const bladeMat = new THREE.MeshStandardMaterial({
      map: makeBladeTexture(),
      roughness: 0.48,
      metalness: 0.06,
      side: THREE.DoubleSide,
    });
    const bladeGeo = new THREE.ExtrudeGeometry(makeBladeShape(), {
      depth: BLADE_THICK,
      bevelEnabled: true,
      bevelThickness: 0.0007,
      bevelSize: 0.0007,
      bevelSegments: 2,
    });
    bladeGeo.rotateX(-Math.PI / 2); // 叶片平面 → 水平
    const blades = new THREE.Group();
    for (const [i, pitch] of [[0, 0.13], [1, -0.13]]) {
      const b = new THREE.Mesh(bladeGeo, bladeMat);
      b.rotation.x = pitch;
      b.rotation.y = i * Math.PI;
      b.castShadow = true;
      blades.add(b);
    }
    this.bladeGroup.add(blades);
    const hub = new THREE.Mesh(
      new THREE.CylinderGeometry(0.014, 0.014, 0.016, 12),
      new THREE.MeshStandardMaterial({ color: 0xc7a65f, roughness: 0.45 })
    );
    hub.position.y = 0.002;
    this.bladeGroup.add(hub);
    this.spinGroup.add(this.bladeGroup);
    this.toy.add(this.spinGroup);

    // 残影(旋转拖尾)
    this.ghosts = GHOST_DEFS.map((def) => {
      const ghost = this.bladeGroup.clone(true);
      ghost.traverse((o) => {
        if (o.isMesh) {
          o.material = new THREE.MeshBasicMaterial({
            color: 0xffedbe,
            transparent: true,
            opacity: def.op,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side: THREE.DoubleSide,
          });
          o.castShadow = false;
          o.receiveShadow = false;
        }
      });
      ghost.visible = false;
      this.toy.add(ghost);
      return { ghost, ...def };
    });

    // 高速时的旋转模糊圆盘
    this.disc = new THREE.Mesh(
      new THREE.CircleGeometry(BLADE_SPAN + 0.02, 48),
      new THREE.MeshBasicMaterial({
        map: makeDiscTexture(),
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    this.disc.rotation.x = -Math.PI / 2;
    this.disc.position.y = 0.2425;
    this.disc.visible = false;
    this.toy.add(this.disc);

    this.scene.add(this.toy);
  }

  _particles() {
    const N = 70;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const r = 0.6 + Math.random() * 2.6;
      const a = Math.random() * Math.PI * 2;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = 0.1 + Math.random() * 2.2;
      pos[i * 3 + 2] = Math.sin(a) * r;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xfff4cc,
      size: 0.035,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.motes = new THREE.Points(geo, mat);
    this.moteBase = pos.slice();
    this.scene.add(this.motes);
  }

  resize() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w < h ? 58 : 44;
    this.camera.updateProjectionMatrix();
  }

  /**
   * 每帧更新。
   * @param dt 秒
   * @param state { w: rad/s, t: 累计时间 }
   */
  update(dt, state) {
    this.time += dt;
    const t = this.time;
    const w = state.w;
    const wf = Math.min(1, w / 90); // 抖动强度因子
    const speed = Math.min(1, w / 150); // 残影强度因子

    this.spinAngle = (this.spinAngle + w * dt) % (Math.PI * 2);
    this.spinGroup.rotation.y = this.spinAngle;

    // 残影:角滞后随转速增大,低速时隐藏
    for (const g of this.ghosts) {
      if (w < 9) {
        g.ghost.visible = false;
      } else {
        g.ghost.visible = true;
        g.ghost.rotation.y = this.spinAngle - g.lag * (0.35 + 0.65 * speed);
        g.ghost.traverse((o) => {
          if (o.isMesh) o.material.opacity = g.op * speed;
        });
      }
    }

    // 高速旋转模糊圆盘
    if (w < 12) {
      this.disc.visible = false;
    } else {
      this.disc.visible = true;
      const k = Math.pow(Math.min(1, w / 170), 1.6);
      this.disc.material.opacity = 0.02 + 0.5 * k;
      const s = 1 + 0.015 * Math.sin(t * 40);
      this.disc.scale.set(s, s, 1);
      this.disc.rotation.z = t * 0.3;
    }

    // 竹签高速抖动(竹签在竹筒里晃动的真实感)
    this.bladeGroup.position.x = Math.sin(t * 23.5) * 0.006 * wf;
    this.bladeGroup.position.z = Math.cos(t * 17.3) * 0.006 * wf;
    this.spinGroup.rotation.z = Math.sin(t * 11.7) * 0.022 * wf;
    this.spinGroup.rotation.x = Math.cos(t * 13.1) * 0.018 * wf;

    // 整件玩具轻微悬浮呼吸
    this.toy.position.y = 0.52 + Math.sin(t * 1.4) * 0.013;
    this.toy.rotation.y = Math.sin(t * 0.35) * 0.05;

    // 背景竹叶轻摆
    for (const lf of this.leaves) {
      lf.mesh.rotation.z += Math.sin(t * lf.speed + lf.phase) * 0.0012;
    }

    // 光尘粒子
    const p = this.motes.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      let y = p.getY(i) + dt * 0.09;
      if (y > 2.4) y = 0.05;
      p.setY(i, y);
      p.setX(i, this.moteBase[i * 3] + Math.sin(t * 0.7 + i) * 0.08);
    }
    p.needsUpdate = true;

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.renderer.dispose();
    this.controls.dispose();
  }
}

function leafShape() {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.quadraticCurveTo(0.25, 0.3, 1.6, 0.05);
  s.quadraticCurveTo(0.3, -0.25, 0, 0);
  return s;
}
