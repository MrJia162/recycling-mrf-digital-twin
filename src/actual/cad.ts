import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * The review mesh merges each baler into a single static object. Recover the
 * east-end sliding door as its own group so it can be driven along world Y.
 */
export function extractBalerDoor(source: THREE.Group): THREE.Group | null {
  source.updateMatrixWorld(true);
  const baler = source.getObjectByName('E13');
  if (!baler) return null;
  const meshes: THREE.Mesh[] = [];
  baler.traverse((object) => {
    if (object instanceof THREE.Mesh) meshes.push(object);
  });
  if (!meshes.length) return null;

  const parents = new Map<string, string>();
  const find = (key: string): string => {
    let root = parents.get(key);
    if (root === undefined) {
      parents.set(key, key);
      return key;
    }
    if (root !== key) {
      root = find(root);
      parents.set(key, root);
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const rootA = find(a),
      rootB = find(b);
    if (rootA !== rootB) parents.set(rootB, rootA);
  };
  const keyOf = (point: THREE.Vector3) =>
    `${Math.round(point.x * 1000)},${Math.round(point.y * 1000)},${Math.round(point.z * 1000)}`;

  interface Triangle {
    mesh: THREE.Mesh;
    material: THREE.Material;
    start: number;
    key: string;
  }
  const triangles: Triangle[] = [];
  const point = new THREE.Vector3();
  for (const mesh of meshes) {
    const position = mesh.geometry.getAttribute('position');
    if (!position) continue;
    const index = mesh.geometry.getIndex();
    const count = index ? index.count : position.count;
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    for (let start = 0; start + 2 < count; start += 3) {
      const keys: string[] = [];
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = index ? index.getX(start + corner) : start + corner;
        point.fromBufferAttribute(position, vertex).applyMatrix4(mesh.matrixWorld);
        keys.push(keyOf(point));
      }
      union(keys[0], keys[1]);
      union(keys[0], keys[2]);
      triangles.push({ mesh, material, start, key: keys[0] });
    }
  }
  if (!triangles.length) return null;

  const stats = new Map<
    string,
    { count: number; min: THREE.Vector3; max: THREE.Vector3 }
  >();
  for (const triangle of triangles) {
    const root = find(triangle.key);
    let entry = stats.get(root);
    if (!entry) {
      entry = {
        count: 0,
        min: new THREE.Vector3(Infinity, Infinity, Infinity),
        max: new THREE.Vector3(-Infinity, -Infinity, -Infinity),
      };
      stats.set(root, entry);
    }
    entry.count += 1;
    const position = triangle.mesh.geometry.getAttribute('position');
    const index = triangle.mesh.geometry.getIndex();
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = index ? index.getX(triangle.start + corner) : triangle.start + corner;
      point.fromBufferAttribute(position, vertex).applyMatrix4(triangle.mesh.matrixWorld);
      entry.min.min(point);
      entry.max.max(point);
    }
  }
  let doorKey: string | null = null;
  let doorCount = 0;
  for (const [key, entry] of stats) {
    const size = entry.max.clone().sub(entry.min);
    if (entry.count < 1000 || entry.max.x < 5) continue;
    if ((entry.min.y + entry.max.y) / 2 < 3.2) continue;
    if (size.x > 1.5 || size.y < 1.2 || size.z < 0.8) continue;
    if (entry.count > doorCount) {
      doorCount = entry.count;
      doorKey = key;
    }
  }
  if (!doorKey) return null;

  const doorByMaterial = new Map<
    THREE.Material,
    { positions: number[]; normals: number[] }
  >();
  const restByMesh = new Map<
    THREE.Mesh,
    { positions: number[]; normals: number[] }
  >();
  const normal = new THREE.Vector3();
  for (const triangle of triangles) {
    const { mesh, material, start } = triangle;
    const position = mesh.geometry.getAttribute('position');
    const sourceNormal = mesh.geometry.getAttribute('normal');
    const index = mesh.geometry.getIndex();
    if (find(triangle.key) === doorKey) {
      let entry = doorByMaterial.get(material);
      if (!entry) {
        entry = { positions: [], normals: [] };
        doorByMaterial.set(material, entry);
      }
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = index ? index.getX(start + corner) : start + corner;
        point.fromBufferAttribute(position, vertex).applyMatrix4(mesh.matrixWorld);
        entry.positions.push(point.x, point.y, point.z);
        if (sourceNormal) {
          normal.fromBufferAttribute(sourceNormal, vertex).applyMatrix3(normalMatrix).normalize();
        } else normal.set(0, 1, 0);
        entry.normals.push(normal.x, normal.y, normal.z);
      }
    } else {
      let entry = restByMesh.get(mesh);
      if (!entry) {
        entry = { positions: [], normals: [] };
        restByMesh.set(mesh, entry);
      }
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = index ? index.getX(start + corner) : start + corner;
        point.fromBufferAttribute(position, vertex);
        entry.positions.push(point.x, point.y, point.z);
        if (sourceNormal) normal.fromBufferAttribute(sourceNormal, vertex);
        else normal.set(0, 1, 0);
        entry.normals.push(normal.x, normal.y, normal.z);
      }
    }
  }

  for (const mesh of meshes) {
    const entry = restByMesh.get(mesh);
    if (!entry) {
      mesh.geometry.dispose();
      mesh.removeFromParent();
      continue;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(entry.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(entry.normals, 3));
    mesh.geometry.dispose();
    mesh.geometry = geometry;
  }

  const door = new THREE.Group();
  door.name = 'E13-door';
  for (const [material, entry] of doorByMaterial) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(entry.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(entry.normals, 3));
    door.add(new THREE.Mesh(geometry, material.clone()));
  }
  return door.children.length ? door : null;
}

/** Batch static CAD faces by equipment/material without changing world-space vertices. */
export function batchPlant(source: THREE.Group): THREE.Group {
  source.updateMatrixWorld(true);
  const result = new THREE.Group(),
    sourceGeometries = new Set<THREE.BufferGeometry>();
  source.traverse((root) => {
    if (!/^E\d{2}$/.test(root.name)) return;
    const equipment = new THREE.Group();
    equipment.name = root.name;
    const groups = new Map<string, { material: THREE.Material; geometries: THREE.BufferGeometry[] }>();
    root.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      if (Array.isArray(child.material)) throw new Error('CAD primitive contains unexpected material groups');
      const material = child.material,
        sourceGeometry = child.geometry as THREE.BufferGeometry;
      sourceGeometries.add(sourceGeometry);
      const geometry = new THREE.BufferGeometry();
      for (const name of ['position', 'normal']) {
        const attribute = sourceGeometry.getAttribute(name);
        if (!attribute) continue;
        const values = new Float32Array(attribute.count * 3);
        for (let i = 0; i < attribute.count; i += 1) {
          values[i * 3] = attribute.getX(i);
          values[i * 3 + 1] = attribute.getY(i);
          values[i * 3 + 2] = attribute.getZ(i);
        }
        geometry.setAttribute(name, new THREE.BufferAttribute(values, 3));
      }
      if (sourceGeometry.index) geometry.setIndex(sourceGeometry.index.clone());
      if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
      geometry.applyMatrix4(child.matrixWorld);
      if (!groups.has(material.uuid))
        groups.set(material.uuid, { material: material.clone(), geometries: [] });
      groups.get(material.uuid)!.geometries.push(geometry);
    });
    for (const group of groups.values()) {
      const merged = mergeGeometries(group.geometries);
      if (!merged) throw new Error(`CAD batching failed for ${root.name}`);
      equipment.add(new THREE.Mesh(merged, group.material));
      group.geometries.forEach((geometry) => geometry.dispose());
    }
    result.add(equipment);
  });
  sourceGeometries.forEach((geometry) => geometry.dispose());
  return result;
}
