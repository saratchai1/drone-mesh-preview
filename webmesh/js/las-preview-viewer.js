(function () {
  const params = new URLSearchParams(window.location.search);
  const dataRoot = params.get("data") || "./assets/bangchan-las-preview";
  const title = params.get("name") || "LAS Point Cloud";

  const canvas = document.querySelector("#scene");
  const previewTitle = document.querySelector("#previewTitle");
  const subtitle = document.querySelector("#subtitle");
  const status = document.querySelector("#status");
  const statusText = document.querySelector("#statusText");
  const resetBtn = document.querySelector("#resetBtn");
  const sizeInput = document.querySelector("#sizeInput");

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1110);
  previewTitle.textContent = title;

  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.5, 12000);
  camera.position.set(1200, 900, 1600);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputEncoding = THREE.sRGBEncoding;

  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = true;

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));

  let points = null;
  let bounds = null;

  function setStatus(title, text, state) {
    status.dataset.state = state || "loading";
    status.querySelector("strong").textContent = title;
    statusText.textContent = text;
  }

  function resolveDataUrl(file) {
    return new URL(`${dataRoot.replace(/\/$/, "")}/${file}`, window.location.href).href;
  }

  async function fetchBinary(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    return response.arrayBuffer();
  }

  async function fetchBinaryParts(files) {
    const fileList = Array.isArray(files) ? files : [files];
    const buffers = await Promise.all(fileList.map((file) => fetchBinary(resolveDataUrl(file))));
    const totalBytes = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const buffer of buffers) {
      merged.set(new Uint8Array(buffer), offset);
      offset += buffer.byteLength;
    }
    return merged.buffer;
  }

  function fitCamera() {
    if (!bounds) return;
    const min = new THREE.Vector3(bounds.minX, bounds.minY, bounds.minZ);
    const max = new THREE.Vector3(bounds.maxX, bounds.maxY, bounds.maxZ);
    const box = new THREE.Box3(min, max);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.62;
    const distance = Math.max(400, radius / Math.sin(THREE.MathUtils.degToRad(camera.fov * 0.5)));

    controls.target.copy(center);
    camera.position.copy(center).add(new THREE.Vector3(distance * 0.38, distance * 0.52, distance * 0.72));
    camera.near = Math.max(0.1, distance / 10000);
    camera.far = Math.max(12000, distance * 8);
    camera.updateProjectionMatrix();
    controls.update();
  }

  async function init() {
    try {
      const metadataUrl = resolveDataUrl("metadata.json");
      const metadataResponse = await fetch(metadataUrl);
      if (!metadataResponse.ok) throw new Error(`metadata ${metadataResponse.status}`);
      const metadata = await metadataResponse.json();
      bounds = metadata.sampledBounds;

      subtitle.textContent = `${metadata.sampledPoints.toLocaleString()} sampled of ${metadata.originalPoints.toLocaleString()} LAS points`;
      setStatus("Loading points", "Downloading preview buffers...", "loading");

      const [positionsBuffer, colorsBuffer] = await Promise.all([
        fetchBinaryParts(metadata.files.positions),
        fetchBinaryParts(metadata.files.colors),
      ]);

      const positions = new Float32Array(positionsBuffer);
      const colors = new Uint8Array(colorsBuffer);
      const colorFloats = new Float32Array(colors.length);
      for (let i = 0; i < colors.length; i += 1) colorFloats[i] = colors[i] / 255;

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(colorFloats, 3));
      geometry.computeBoundingSphere();

      const material = new THREE.PointsMaterial({
        size: Number(sizeInput.value),
        vertexColors: true,
        sizeAttenuation: true,
      });

      points = new THREE.Points(geometry, material);
      scene.add(points);

      fitCamera();
      setStatus("Ready", `${metadata.sampledPoints.toLocaleString()} sampled points | stride ${metadata.sampleStride}`, "ready");
    } catch (error) {
      console.error(error);
      setStatus("Cannot open LAS preview", error.message, "error");
    }
  }

  resetBtn.addEventListener("click", fitCamera);
  sizeInput.addEventListener("input", () => {
    if (points) points.material.size = Number(sizeInput.value);
  });

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  function animate() {
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }

  animate();
  init();
})();
