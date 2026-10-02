// 3D buildings from the NYC 3D Model, drawn with three.js in a MapLibre custom layer.
// Each community district is one glTF in data/3d, converted by tools/rhino_to_glb.py:
// metres in a local frame centred on origin_lonlat, x east, y up, z south.

/* global maplibregl */

const MANIFEST = 'data/3d/models.json';
const LAYER_ID = 'buildings-3d';

let layerPromise;

// Turns the 3D view on or off: tilts the map, allows rotation, and shows the models.
export async function set3D(map, on) {
  if (on) {
    map.dragRotate.enable();
    map.touchZoomRotate.enableRotation();
    const { districts } = await (layerPromise ??= addLayer(map));
    map.setLayoutProperty(LAYER_ID, 'visibility', 'visible');
    // Bring the camera to the model when it is out of view or too far out to read.
    const [lon, lat] = districts[0].origin_lonlat;
    const inView = map.getBounds().contains([lon, lat]);
    map.easeTo({ pitch: 60, ...(inView && map.getZoom() >= 14 ? {} : { center: [lon, lat], zoom: 15 }), duration: 1200 });
  } else {
    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();
    if (map.getLayer(LAYER_ID)) map.setLayoutProperty(LAYER_ID, 'visibility', 'none');
    map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
  }
}

async function addLayer(map) {
  const [THREE, { GLTFLoader }, { MeshoptDecoder }, manifest] = await Promise.all([
    import('three'),
    import('three/addons/loaders/GLTFLoader.js'),
    import('three/addons/libs/meshopt_decoder.module.js'),
    fetch(MANIFEST).then((r) => r.json()),
  ]);
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const models = manifest.districts.map((d) => {
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(0.5, 1, 0.3);
    scene.add(sun);
    loader.load(`data/3d/${d.file}`, (gltf) => {
      // Faces have no stored normals; flat shading lights each wall and roof evenly.
      gltf.scene.traverse((o) => { if (o.isMesh) o.material.flatShading = true; });
      scene.add(gltf.scene);
      map.triggerRepaint();
    }, undefined, (err) => console.warn(`3D model ${d.file} unavailable:`, err));
    // Model metres to Mercator: Mercator y grows southward, so flip y, then stand
    // the y-up model on the map plane. Combined with the map's matrix in float64
    // each frame, because float32 alone jitters by about a metre at this scale.
    const origin = maplibregl.MercatorCoordinate.fromLngLat(d.origin_lonlat, 0);
    const s = origin.meterInMercatorCoordinateUnits();
    const toMercator = new THREE.Matrix4().makeTranslation(origin.x, origin.y, origin.z)
      .scale(new THREE.Vector3(s, -s, s))
      .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    return { scene, toMercator };
  });

  let renderer, camera;
  map.addLayer({
    id: LAYER_ID,
    type: 'custom',
    renderingMode: '3d',
    onAdd(m, gl) {
      camera = new THREE.Camera();
      renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
    },
    render(gl, matrix) {
      renderer.resetState();
      for (const { scene, toMercator } of models) {
        camera.projectionMatrix.fromArray(matrix).multiply(toMercator);
        renderer.render(scene, camera);
      }
    },
  }, 'cursor-fill');
  return manifest;
}
