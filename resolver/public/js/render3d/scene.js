import * as THREE from '../vendor/three.module.min.js';
import { HEIGHT, podiumHeights, text } from './graphics.js';

const background = new THREE.PlaneGeometry(1, 1);
const eased = t => 1 - (1 - t) ** 3;

function surface(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    map.minFilter = THREE.LinearFilter;
    map.generateMipmaps = false;
    return {
        ctx, map,
        paint(draw) {
            ctx.clearRect(0, 0, width, height);
            draw(ctx, width, height);
            map.needsUpdate = true;
        },
    };
}

function plane(group, w, h, material, x = 0, y = 0, z = 0) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
}

function beamMaterial() {
    return new THREE.ShaderMaterial({
        depthWrite: false,
        uniforms: { beat: { value: 0 }, accent: { value: 1 } },
        vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
        fragmentShader: [
            'varying vec2 vUv; uniform float beat; uniform float accent;',
            'void main() {',
            '  vec2 p = vUv;',
            '  float wash = exp(-length((p - vec2(.78,.41))*vec2(2.4,2.8))*3.25);',
            '  float stripe = abs(p.x - (.52 + p.y*.42 + beat*.024));',
            '  float cut = (1. - smoothstep(.011,.042,stripe)) * (.15+.35*p.y);',
            '  float floor = exp(-abs(p.y - .127)*24.) * .012;',
            '  vec3 base = vec3(.029,.037,.063);',
            '  gl_FragColor = vec4(base + vec3(.018,.053,.19) * (wash*1.3 + cut*accent + floor*2.), 1.);',
            '}',
        ].join('\n'),
    });
}

function block(group, w, h, depth, color, edge, x = 0, y = 0, z = 0) {
    const bevel = Math.min(6, h * .08);
    const shape = new THREE.Shape();
    shape.moveTo(-w / 2, -h / 2);
    shape.lineTo(w / 2, -h / 2);
    shape.lineTo(w / 2, h / 2);
    shape.lineTo(-w / 2, h / 2);
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, {
        depth: depth - 2 * bevel, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 1,
    });
    geometry.translate(0, 0, -depth / 2 + bevel);
    const material = new THREE.MeshStandardMaterial({ color, metalness: .23, roughness: .48 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    group.add(mesh);
    if (edge) plane(group, w, 3.5, new THREE.MeshBasicMaterial({ color: edge }), x, y + h / 2 + 2, z + depth / 2 + .1);
    return mesh;
}

function printedFace(group, w, h, z = 0) {
    const face = surface(512, Math.max(16, Math.round(512 * h / w)));
    const mesh = plane(group, w, h, new THREE.MeshBasicMaterial({ map: face.map, transparent: true, toneMapped: false }), 0, 0, z);
    return { ...face, mesh };
}

function makeOpening(scene) {
    const holder = new THREE.Group();
    scene.add(holder);
    block(holder, 482, 20, 291, 0x121a2c, 0x2447a5, -12, -9, -12);
    for (const [index, height] of [108, 211, 322, 432].entries()) {
        const x = (index - 1.5) * 107;
        block(holder, 98, height, 195, 0x1638a5, 0x759bff, x, height / 2, -index * 18);
    }
    return holder;
}

function makeTile(scene) {
    const holder = new THREE.Group(), flap = new THREE.Group();
    scene.add(holder); holder.add(flap);
    block(holder, 334, 334, 28, 0x182b5d, 0x4671ff, 0, 0, -31);
    block(flap, 304, 304, 23, 0x171d2c, 0x577cff);
    const front = printedFace(flap, 293, 293, 12);
    const back = printedFace(flap, 293, 293, -12);
    back.mesh.rotation.x = Math.PI;
    return { holder, flap, front, back };
}

function paintTile(face, value, kind) {
    face.paint((ctx, w, h) => {
        const tone = ctx.createLinearGradient(2, 0, w, h);
        tone.addColorStop(0, kind === 'solved' ? '#285aff' : kind === 'failed' ? '#442233' : '#1c2436');
        tone.addColorStop(1, kind === 'solved' ? '#102c9c' : '#090d18');
        ctx.fillStyle = tone; ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = kind === 'failed' ? '#834353' : '#5077ff';
        ctx.lineWidth = 3; ctx.strokeRect(4, 4, w - 8, h - 8);
        text(ctx, value, w / 2, h / 2 + 8, w * .85, h * .62, { align: 'center', numeric: true, weight: 850 });
        ctx.fillStyle = '#080c14'; ctx.fillRect(0, h / 2 - 2, w, 5);
        ctx.fillStyle = '#798097'; ctx.fillRect(0, h / 2 + 4, w * .021, 3); ctx.fillRect(w * .979, h / 2 + 4, w * .021, 3);
    });
}

function makePodiums(scene) {
    return podiumHeights.map((height, rank) => {
        const holder = new THREE.Group();
        scene.add(holder);
        const w = rank ? 437 : 474, depth = 186;
        block(holder, w, height, depth, rank ? 0x232d40 : 0x2445bf, rank ? 0x537cff : 0x91acff, 0, height / 2, 0);
        const number = printedFace(holder, w * .72, height * .65, depth / 2 + .2);
        number.mesh.position.y = height * .5;
        number.paint((ctx, sw, sh) => text(ctx, rank + 1, sw / 2, sh * .51, sw * .88, sh * .92,
            { align: 'center', numeric: true, weight: 900 }));
        return holder;
    });
}

export class BroadcastScene {
    constructor(renderer) {
        this.renderer = renderer;
        this.scene = new THREE.Scene();
        this.camera = new THREE.OrthographicCamera(0, 1920, HEIGHT, 0, .1, 5000);
        this.camera.position.z = 2000;
        const key = new THREE.DirectionalLight(0xe7efff, 2.8);
        key.position.set(-500, 800, 750);
        const blue = new THREE.DirectionalLight(0x386cff, 3.4);
        blue.position.set(600, -200, -400);
        this.scene.add(new THREE.HemisphereLight(0xcbd7ff, 0x0e1221, 1.6), key, blue);
        this.beam = beamMaterial();
        this.wall = new THREE.Mesh(background.clone(), this.beam);
        this.wall.position.z = -360;
        this.wall.renderOrder = -1;
        this.scene.add(this.wall);
        this.opening = makeOpening(this.scene);
        this.tile = makeTile(this.scene);
        this.podiums = makePodiums(this.scene);
        this.overlay = new THREE.Mesh(background.clone(), new THREE.MeshBasicMaterial({
            transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
        }));
        this.overlay.renderOrder = 20;
        this.scene.add(this.overlay);
    }

    resize(layout, width, height) {
        this.L = layout;
        this.renderer.setSize(width, height, false);
        this.camera.right = layout.width;
        this.camera.updateProjectionMatrix();
        for (const mesh of [this.wall, this.overlay]) {
            mesh.position.x = layout.width / 2;
            mesh.position.y = HEIGHT / 2;
            mesh.scale.set(layout.width, HEIGHT, 1);
        }
        const scale = Math.min(width / layout.width, 1.35, 3350 / layout.width);
        this.overlay.material.map?.dispose();
        this.hud = surface(Math.round(layout.width * scale), Math.round(HEIGHT * scale));
        this.hud.ctx.scale(this.hud.ctx.canvas.width / layout.width, this.hud.ctx.canvas.height / HEIGHT);
        this.overlay.material.map = this.hud.map;
        this.overlay.material.needsUpdate = true;
    }

    pose({ act, camera, enter, focus, flip, winners, podiumProgress }) {
        const L = this.L;
        // Only the physical props react to the camera. Score columns never tilt.
        const yaw = camera === 'front' ? 0 : camera === 'side' ? .34 : .17 + (1 - enter) * .13;
        this.beam.uniforms.accent.value = act === 3 ? .55 : 1;
        this.beam.uniforms.beat.value = 1 - enter;
        this.opening.visible = act === 1;
        if (this.opening.visible) {
            this.opening.rotation.set(.17, -.40 + yaw / 2, -.05);
            this.opening.scale.setScalar(Math.min(1.3, L.inner / 1560) * (.94 + enter * .06));
            this.opening.position.set(L.openingX + (1 - enter) * 40, 164 - (1 - enter) * 32, 0);
        }
        const tile = this.tile;
        tile.holder.visible = act === 3 && !!focus;
        if (tile.holder.visible) {
            const { label, result } = focus;
            const key = label + '\0' + (result?.status || '');
            if (this.tileKey !== key) {
                this.tileKey = key;
                paintTile(tile.front, label, 'pending');
                paintTile(tile.back, result?.status === 'solved' ? '✓' : '×', result?.status);
            }
            tile.holder.position.set(L.focusX, HEIGHT - 557, 24);
            tile.holder.scale.setScalar(L.tile / 334);
            tile.holder.rotation.set(.075, -yaw * .78, 0);
            tile.flap.rotation.x = -Math.PI * (flip < .5 ? 2 * flip ** 2 : 1 - 2 * (1 - flip) ** 2);
        }
        for (let i = 0; i < this.podiums.length; i++) {
            const plinth = this.podiums[i];
            plinth.visible = act === 4 && !!winners[i]?.teamIds.length;
            if (!plinth.visible) continue;
            const rise = eased(podiumProgress[i]);
            plinth.position.set(L.podiumX[i] + (i === 0 ? 0 : Math.sign(i - 1.5) * (1 - rise) * 35), 162, i ? -45 : 22);
            plinth.rotation.set(.13, -.16 + yaw * .6, 0);
            plinth.scale.set(L.podiumUnit, L.podiumUnit * (.02 + .98 * rise), L.podiumUnit);
        }
    }

    paint(draw) {
        this.hud.ctx.clearRect(0, 0, this.L.width, HEIGHT);
        draw(this.hud.ctx);
        this.hud.map.needsUpdate = true;
    }

    render() { this.renderer.render(this.scene, this.camera); }

    dispose() {
        const geometries = new Set(), materials = new Set(), maps = new Set();
        this.scene.traverse(object => {
            if (object.geometry) geometries.add(object.geometry);
            if (object.material) materials.add(object.material);
        });
        for (const material of materials) {
            if (material.map) maps.add(material.map);
            material.dispose();
        }
        for (const geometry of geometries) geometry.dispose();
        for (const map of maps) map.dispose();
    }
}
