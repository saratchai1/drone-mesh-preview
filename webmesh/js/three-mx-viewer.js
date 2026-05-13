(function () {
  const defaultSrc = "/ieat/bangchan/%E0%B8%99%E0%B8%B4%E0%B8%84%E0%B8%A1%E0%B8%AD%E0%B8%B8%E0%B8%95%E0%B8%AA%E0%B8%B2%E0%B8%AB%E0%B8%81%E0%B8%A3%E0%B8%A3%E0%B8%A1%E0%B8%9A%E0%B8%B2%E0%B8%87%E0%B8%8A%E0%B8%B1%E0%B8%99.3mx";
  const params = new URLSearchParams(window.location.search);
  const src = params.get("src") || defaultSrc;
  const initialMaxDepth = Number(params.get("depth") || 3);
  const initialMaxTiles = Number(params.get("tiles") || 24);

  const canvas = document.querySelector("#scene");
  const subtitle = document.querySelector("#subtitle");
  const status = document.querySelector("#status");
  const statusText = document.querySelector("#statusText");
  const resetBtn = document.querySelector("#resetBtn");
  const wireBtn = document.querySelector("#wireBtn");
  const moreBtn = document.querySelector("#moreBtn");

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1110);

  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.5, 12000);
  camera.position.set(2200, -2600, 1800);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputEncoding = THREE.sRGBEncoding;

  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = true;
  controls.target.set(0, 0, -1550);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x33443b, 1.8));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(2200, -2600, 3200);
  scene.add(sun);

  const modelRoot = new THREE.Group();
  scene.add(modelRoot);

  let baseUrl = "";
  let maxDepth = initialMaxDepth;
  let maxTiles = initialMaxTiles;
  let loadedTiles = 0;
  let queuedTiles = 0;
  let loadedMeshes = 0;
  let loadedTriangles = 0;
  let wireframe = false;
  let fitting = false;
  let finalFitDone = false;
  const loadedTileUrls = new Set();
  const queuedTileUrls = new Set();
  const textureUrls = [];

  function setStatus(title, text, state) {
    status.dataset.state = state || "loading";
    status.querySelector("strong").textContent = title;
    statusText.textContent = text;
  }

  function resolveUrl(path, base) {
    return new URL(path, base).href;
  }

  function parse3mxb(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (magic !== "3MXB") {
      throw new Error("Invalid 3MXB tile");
    }

    const jsonLength = view.getUint32(5, true);
    const jsonStart = 9;
    const jsonEnd = jsonStart + jsonLength;
    const jsonText = new TextDecoder().decode(new Uint8Array(arrayBuffer, jsonStart, jsonLength));
    const tile = JSON.parse(jsonText);

    let offset = jsonEnd;
    const resources = new Map();
    for (const resource of tile.resources || []) {
      const size = resource.size || 0;
      resources.set(resource.id, {
        meta: resource,
        buffer: arrayBuffer.slice(offset, offset + size),
      });
      offset += size;
    }

    return { tile, resources };
  }

  function geometryFromCtm(buffer) {
    const stream = new CTM.Stream(new Uint8Array(buffer));
    const ctmFile = new CTM.File(stream);
    const body = ctmFile.body;

    const geometry = new THREE.BufferGeometry();
    geometry.setIndex(new THREE.BufferAttribute(body.indices, 1));
    geometry.setAttribute("position", new THREE.BufferAttribute(body.vertices, 3));

    if (body.normals) {
      geometry.setAttribute("normal", new THREE.BufferAttribute(body.normals, 3));
    } else {
      geometry.computeVertexNormals();
    }

    if (body.uvMaps && body.uvMaps.length > 0) {
      geometry.setAttribute("uv", new THREE.BufferAttribute(body.uvMaps[0].uv, 2));
    }

    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  function textureFromBuffer(buffer) {
    const blob = new Blob([buffer], { type: "image/jpeg" });
    const url = URL.createObjectURL(blob);
    textureUrls.push(url);
    const texture = new THREE.TextureLoader().load(url, () => {
      renderer.render(scene, camera);
    });
    texture.encoding = THREE.sRGBEncoding;
    texture.flipY = false;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
  }

  async function loadTile(tileUrl, depth) {
    if (loadedTiles >= maxTiles || loadedTileUrls.has(tileUrl) || queuedTileUrls.has(tileUrl)) return;
    queuedTileUrls.add(tileUrl);
    queuedTiles += 1;
    updateProgress();

    try {
      const response = await fetch(tileUrl);
      if (!response.ok) throw new Error(`Tile ${response.status}`);
      const { tile, resources } = parse3mxb(await response.arrayBuffer());

      loadedTileUrls.add(tileUrl);
      loadedTiles += 1;

      const textures = new Map();
      for (const resource of tile.resources || []) {
        if (resource.type === "textureBuffer") {
          textures.set(resource.id, textureFromBuffer(resources.get(resource.id).buffer));
        }
      }

      for (const resource of tile.resources || []) {
        if (resource.type !== "geometryBuffer" || resource.format !== "ctm") continue;

        const geometry = geometryFromCtm(resources.get(resource.id).buffer);
        const material = new THREE.MeshLambertMaterial({
          map: textures.get(resource.texture) || null,
          side: THREE.DoubleSide,
          wireframe,
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData.tileUrl = tileUrl;
        modelRoot.add(mesh);
        loadedMeshes += 1;
        loadedTriangles += geometry.index ? geometry.index.count / 3 : 0;
      }

      fitCamera(false);

      if (depth < maxDepth && loadedTiles < maxTiles) {
        const children = [];
        for (const node of tile.nodes || []) {
          for (const child of node.children || []) children.push(resolveUrl(child, tileUrl));
        }
        for (const childUrl of children) {
          if (loadedTiles >= maxTiles) break;
          await loadTile(childUrl, depth + 1);
        }
      }
    } catch (error) {
      console.error(error);
      setStatus("Load error", error.message, "error");
    } finally {
      queuedTiles -= 1;
      updateProgress();
    }
  }

  function updateProgress() {
    if (loadedMeshes === 0) {
      setStatus("Loading 3MX", `${loadedTiles} tiles loaded, ${queuedTiles} queued`, "loading");
      return;
    }

    const triangleText = Math.round(loadedTriangles).toLocaleString();
    const state = queuedTiles > 0 ? "loading" : "ready";
    const title = queuedTiles > 0 ? "Loading tiles" : "Ready";
    setStatus(title, `${loadedTiles} tiles, ${loadedMeshes} meshes, ${triangleText} triangles`, state);

    if (queuedTiles === 0 && !finalFitDone) {
      finalFitDone = true;
      fitCamera(true);
    }
  }

  function fitCamera(force) {
    if (fitting && !force) return;
    fitting = true;
    requestAnimationFrame(() => {
      const box = new THREE.Box3().setFromObject(modelRoot);
      if (box.isEmpty()) {
        fitting = false;
        return;
      }

      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const radius = Math.max(size.x, size.y, size.z) * 0.62;
      const distance = Math.max(600, radius / Math.sin(THREE.MathUtils.degToRad(camera.fov * 0.5)));

      if (force || loadedTiles <= 2) {
        camera.position.copy(center).add(new THREE.Vector3(distance * 0.45, -distance * 0.8, distance * 0.55));
        controls.target.copy(center);
        camera.near = Math.max(0.5, distance / 10000);
        camera.far = Math.max(12000, distance * 6);
        camera.updateProjectionMatrix();
        controls.update();
      }

      fitting = false;
    });
  }

  async function init() {
    try {
      const manifestResponse = await fetch(src);
      if (!manifestResponse.ok) throw new Error(`3MX manifest ${manifestResponse.status}`);

      const manifest = await manifestResponse.json();
      const layer = manifest.layers && manifest.layers[0];
      if (!layer || !layer.root) throw new Error("3MX manifest has no root tile");

      document.title = `${manifest.name || "3MX"} Viewer`;
      subtitle.textContent = `${layer.type || "mesh"} | depth ${maxDepth} | max ${maxTiles} tiles`;
      baseUrl = new URL(src, window.location.href).href;

      await loadTile(resolveUrl(layer.root, baseUrl), 0);
      updateProgress();
    } catch (error) {
      console.error(error);
      setStatus("Cannot open 3MX", error.message, "error");
    }
  }

  resetBtn.addEventListener("click", () => fitCamera(true));

  wireBtn.addEventListener("click", () => {
    wireframe = !wireframe;
    wireBtn.classList.toggle("active", wireframe);
    modelRoot.traverse((object) => {
      if (object.isMesh && object.material) object.material.wireframe = wireframe;
    });
  });

  moreBtn.addEventListener("click", async () => {
    maxDepth += 1;
    maxTiles += 24;
    finalFitDone = false;
    moreBtn.textContent = `More ${maxDepth}`;
    subtitle.textContent = `meshPyramid | depth ${maxDepth} | max ${maxTiles} tiles`;
    const manifestResponse = await fetch(src);
    const manifest = await manifestResponse.json();
    const rootUrl = resolveUrl(manifest.layers[0].root, baseUrl);
    await loadTile(rootUrl, 0);
  });

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  window.addEventListener("beforeunload", () => {
    for (const url of textureUrls) URL.revokeObjectURL(url);
  });

  function animate() {
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }

  animate();
  init();
})();
