import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, Line, OrbitControls } from "@react-three/drei";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import * as THREE from "three";
import { ActualSimulation, openGate } from "./engine";
import {
  CAPACITY,
  EQUIPMENT,
  EQUIPMENT_IDS,
  MANUAL_PATH,
  MATERIALS,
  PLAYBACK_HORIZON,
  ROUTES,
  SMALL_GRADES,
  along,
  center,
  smallPosition,
  type EquipmentId,
  type Grade,
  type Point,
} from "./process";
import cad from "./cad-layout.json";
import { batchPlant, extractBalerDoor } from "./cad";

export type CameraView = "overview" | "top" | "focus";
interface Props {
  simulation: ActualSimulation;
  selected: EquipmentId | null;
  onSelect: (id: EquipmentId) => void;
  xray: boolean;
  paths: boolean;
  shell: boolean;
  view: CameraView;
}
function routeColor(id: string) {
  return id === "air3A" || id === "discharge3A"
    ? MATERIALS["3A"].color
    : id.includes("Mixed")
      ? MATERIALS.MIXED.color
      : id.includes("Misc") || id.includes("manual")
        ? "#e9bf75"
        : "#4bd6ff";
}
const SCENE_BLUE = "#04101f";
const DEVICE_BLUE = new THREE.Color("#3f7fa6");
function deviceTone(source: THREE.Color): THREE.Color {
  const color = source.clone().convertLinearToSRGB();
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl);
  if (hsl.s < 0.16) {
    const light = THREE.MathUtils.clamp(hsl.l * 0.72 + 0.12, 0.1, 0.82);
    color.setHSL(0.56, 0.24, light);
  } else if (hsl.h >= 0.07 && hsl.h <= 0.17) {
    color.setHSL(
      0.1,
      0.6,
      THREE.MathUtils.clamp(hsl.l * 0.9 + 0.16, 0.3, 0.62),
    );
  } else if (hsl.h <= 0.05 || hsl.h >= 0.94) {
    color.setHSL(0.015, 0.62, 0.48);
  } else {
    color.setHSL(
      0.54 + (hsl.l > 0.55 ? 0.02 : 0),
      0.52,
      THREE.MathUtils.clamp(hsl.l * 0.55 + 0.22, 0.22, 0.68),
    );
  }
  color.convertSRGBToLinear();
  return color.lerp(DEVICE_BLUE, 0.12);
}
const FLOW_SPEED = 2.4;
function FlowPaths() {
  const arrows = useRef<THREE.InstancedMesh>(null);
  const dummy = useRef(new THREE.Object3D());
  const up = useRef(new THREE.Vector3(0, 1, 0));
  const direction = useRef(new THREE.Vector3());
  const routes = useMemo(
    () =>
      Object.entries(ROUTES).map(([id, route]) => {
        const length = route.points.slice(1).reduce((sum, point, index) => {
          const prev = route.points[index];
          return (
            sum +
            Math.hypot(
              point[0] - prev[0],
              point[1] - prev[1],
              point[2] - prev[2],
            )
          );
        }, 0);
        return {
          id,
          route,
          color: routeColor(id),
          length,
          count: Math.max(2, Math.round(length / 3)),
        };
      }),
    [],
  );
  const total = useMemo(
    () => routes.reduce((sum, entry) => sum + entry.count, 0),
    [routes],
  );
  const colors = useMemo(
    () =>
      routes.flatMap(({ color, count }) =>
        Array.from({ length: count }, () => color),
      ),
    [routes],
  );
  useFrame(({ clock }) => {
    if (!arrows.current) return;
    let index = 0;
    for (const { route, length, count } of routes) {
      const base = (clock.elapsedTime * FLOW_SPEED) / Math.max(0.001, length);
      for (let slot = 0; slot < count; slot += 1) {
        const progress = (base + slot / count) % 1;
        const p = along(route.points, progress);
        const before = along(route.points, Math.max(0, progress - 0.02));
        const after = along(route.points, Math.min(1, progress + 0.02));
        direction.current.set(
          after[0] - before[0],
          after[1] - before[1],
          after[2] - before[2],
        );
        if (direction.current.lengthSq() < 0.00001)
          direction.current.set(1, 0, 0);
        direction.current.normalize();
        dummy.current.position.set(...p);
        dummy.current.quaternion.setFromUnitVectors(
          up.current,
          direction.current,
        );
        dummy.current.updateMatrix();
        arrows.current.setMatrixAt(index, dummy.current.matrix);
        index += 1;
      }
    }
    arrows.current.count = index;
    arrows.current.instanceMatrix.needsUpdate = true;
  });
  return (
    <>
      {routes.map(({ id, route, color }) => (
        <Line
          key={id}
          points={route.points}
          color={color}
          lineWidth={3}
          transparent
          opacity={0.5}
          depthTest={false}
        />
      ))}
      <instancedMesh
        ref={(node) => {
          arrows.current = node;
          if (!node) return;
          colors.forEach((color, index) =>
            node.setColorAt(index, new THREE.Color(color)),
          );
          if (node.instanceColor) node.instanceColor.needsUpdate = true;
        }}
        args={[undefined, undefined, total]}
        frustumCulled={false}
        renderOrder={5}
      >
        <coneGeometry args={[0.1, 0.3, 10]} />
        <meshBasicMaterial
          color="#ffffff"
          transparent
          opacity={0.95}
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
        />
      </instancedMesh>
    </>
  );
}

const REPLACED_ID = "E25";
const SHELL_Y_OFFSET = -0.06;
const UNMOVED_IDS = new Set<string>([
  "E01",
  "E19",
  "E20",
  "E21",
  "E22",
  "E23",
  "E24",
]);
const LINE_CENTER = EQUIPMENT_IDS.reduce(
  (bounds, id) => {
    const b = cad[id].bounds;
    bounds.minX = Math.min(bounds.minX, b[0]);
    bounds.minZ = Math.min(bounds.minZ, b[2]);
    bounds.maxX = Math.max(bounds.maxX, b[3]);
    bounds.maxZ = Math.max(bounds.maxZ, b[5]);
    return bounds;
  },
  { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity },
);
const MODEL_OFFSET: Point = [
  cad.E01.center[0] - (LINE_CENTER.minX + LINE_CENTER.maxX) / 2,
  0,
  cad.E01.center[2] - (LINE_CENTER.minZ + LINE_CENTER.maxZ) / 2,
];
const SHELL_SCALE = 1.5;
const SHELL_FLOOR_Y = 1.2;
const SHELL_EXTRA_HEIGHT = 2;
const SHELL_BASE_HEIGHT = cad.E01.bounds[4] - SHELL_FLOOR_Y;
const SHELL_SCALE_Y =
  (SHELL_BASE_HEIGHT * SHELL_SCALE + SHELL_EXTRA_HEIGHT) / SHELL_BASE_HEIGHT;
const SHELL_PIVOT: Point = [
  cad.E01.center[0],
  SHELL_FLOOR_Y,
  cad.E01.center[2],
];
const SHELL_POSITION: Point = [
  SHELL_PIVOT[0] * (1 - SHELL_SCALE),
  SHELL_PIVOT[1] * (1 - SHELL_SCALE_Y) + SHELL_Y_OFFSET,
  SHELL_PIVOT[2] * (1 - SHELL_SCALE),
];
const SHELL_WIDTH = (cad.E01.bounds[3] - cad.E01.bounds[0]) * SHELL_SCALE;
const SHELL_DEPTH = (cad.E01.bounds[5] - cad.E01.bounds[2]) * SHELL_SCALE;
const PARTITION_IDS = ["E19", "E20", "E21", "E22", "E23", "E24"];
const STORAGE_START_Z = cad.E01.bounds[5] - 0.5;
const STORAGE_BAY_WIDTH = 4;
const STORAGE_MIN_X = cad.E19.bounds[0];
const STORAGE_MAX_X = cad.E19.bounds[3];
const STORAGE_X = (STORAGE_MIN_X + STORAGE_MAX_X) / 2;
const STORAGE_LINE_Y = 1.19;
const STORAGE_LABEL_Y = 1.21;
const PARTITION_OFFSET_Z = Object.fromEntries(
  PARTITION_IDS.map((id, index) => {
    const b = cad[id as keyof typeof cad].bounds;
    return [
      id,
      STORAGE_START_Z - (index + 1) * STORAGE_BAY_WIDTH - (b[2] + b[5]) / 2,
    ];
  }),
) as Record<string, number>;
const STORAGE_ZONES: { grade: Grade; label: string; bay: number }[] = [
  { grade: "MIXED", label: "染色PET", bay: 1 },
  { grade: "SMALL_WHITE", label: "小白", bay: 2 },
  { grade: "BIG_WHITE", label: "大白", bay: 3 },
  { grade: "FLOWER", label: "花乙", bay: 4 },
  { grade: "OIL", label: "油壶", bay: 5 },
  { grade: "CAN", label: "易拉罐", bay: 6 },
  { grade: "3A", label: "3A", bay: 0 },
];
const STORAGE_LABEL_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  color: "#ffd34d",
  textShadow: "0 1px 3px rgba(0, 0, 0, 0.85)",
  font: '600 18px/1.2 "Microsoft YaHei", "PingFang SC", sans-serif',
  pointerEvents: "none",
  userSelect: "none",
  whiteSpace: "nowrap",
};
function StorageZones() {
  return (
    <>
      {STORAGE_ZONES.map((zone) => {
        const front = STORAGE_START_Z - zone.bay * STORAGE_BAY_WIDTH;
        const back = front - STORAGE_BAY_WIDTH;
        return (
          <group key={`storage-${zone.grade}`}>
            <Line
              points={[
                [STORAGE_MIN_X, STORAGE_LINE_Y, front],
                [STORAGE_MAX_X, STORAGE_LINE_Y, front],
                [STORAGE_MAX_X, STORAGE_LINE_Y, back],
                [STORAGE_MIN_X, STORAGE_LINE_Y, back],
                [STORAGE_MIN_X, STORAGE_LINE_Y, front],
              ]}
              color="#f7c948"
              lineWidth={2}
              dashed
              dashSize={0.5}
              gapSize={0.35}
              transparent
              opacity={0.95}
              depthWrite={false}
            />
            <Html
              position={[STORAGE_X, STORAGE_LABEL_Y, (front + back) / 2]}
              rotation={[-Math.PI / 2, 0, Math.PI / 2]}
              transform
            >
              <span style={STORAGE_LABEL_STYLE}>{zone.label}</span>
            </Html>
          </group>
        );
      })}
    </>
  );
}
const ZONE_MARGIN = 0.22;
const ZONE_Y = 1.19;
const ZONE_EPSILON = 1e-6;
interface ZoneRect {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}
interface ZoneSegment {
  fixed: number;
  start: number;
  end: number;
}
function mergeZoneSegments(segments: ZoneSegment[]): ZoneSegment[] {
  const groups = new Map<string, ZoneSegment[]>();
  for (const segment of segments) {
    const key = segment.fixed.toFixed(5);
    const group = groups.get(key);
    if (group) group.push(segment);
    else groups.set(key, [segment]);
  }
  const merged: ZoneSegment[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.start - b.start);
    let current = { ...group[0] };
    for (const segment of group.slice(1)) {
      if (segment.start <= current.end + ZONE_EPSILON)
        current.end = Math.max(current.end, segment.end);
      else {
        merged.push(current);
        current = { ...segment };
      }
    }
    merged.push(current);
  }
  return merged;
}
function unionZoneOutline(rects: ZoneRect[]): Point[][] {
  const xs = [...new Set(rects.flatMap((rect) => [rect.minX, rect.maxX]))].sort(
    (a, b) => a - b,
  );
  const zs = [...new Set(rects.flatMap((rect) => [rect.minZ, rect.maxZ]))].sort(
    (a, b) => a - b,
  );
  const columns = xs.length - 1,
    rows = zs.length - 1;
  const covered = Array.from({ length: columns }, (_, column) =>
    Array.from({ length: rows }, (_, row) => {
      const x = (xs[column] + xs[column + 1]) / 2,
        z = (zs[row] + zs[row + 1]) / 2;
      return rects.some(
        (rect) =>
          x > rect.minX && x < rect.maxX && z > rect.minZ && z < rect.maxZ,
      );
    }),
  );
  const isCovered = (column: number, row: number) =>
    column >= 0 &&
    row >= 0 &&
    column < columns &&
    row < rows &&
    covered[column][row];
  const vertical: ZoneSegment[] = [],
    horizontal: ZoneSegment[] = [];
  for (let column = 0; column <= columns; column += 1)
    for (let row = 0; row < rows; row += 1)
      if (isCovered(column - 1, row) !== isCovered(column, row))
        vertical.push({ fixed: xs[column], start: zs[row], end: zs[row + 1] });
  for (let row = 0; row <= rows; row += 1)
    for (let column = 0; column < columns; column += 1)
      if (isCovered(column, row - 1) !== isCovered(column, row))
        horizontal.push({
          fixed: zs[row],
          start: xs[column],
          end: xs[column + 1],
        });
  return [
    ...mergeZoneSegments(vertical).map((segment): Point[] => [
      [segment.fixed, ZONE_Y, segment.start],
      [segment.fixed, ZONE_Y, segment.end],
    ]),
    ...mergeZoneSegments(horizontal).map((segment): Point[] => [
      [segment.start, ZONE_Y, segment.fixed],
      [segment.end, ZONE_Y, segment.fixed],
    ]),
  ];
}
function EquipmentZones() {
  const lines = useMemo(
    () =>
      unionZoneOutline(
        EQUIPMENT_IDS.map((id) => {
          const [minX, , minZ, maxX, , maxZ] = cad[id].bounds;
          return {
            minX: minX - ZONE_MARGIN,
            minZ: minZ - ZONE_MARGIN,
            maxX: maxX + ZONE_MARGIN,
            maxZ: maxZ + ZONE_MARGIN,
          };
        }),
      ),
    [],
  );
  return (
    <>
      {lines.map((points, index) => (
        <Line
          key={index}
          points={points}
          color="#f7c948"
          lineWidth={2}
          transparent
          opacity={0.9}
          depthWrite={false}
        />
      ))}
    </>
  );
}

const BAG_PROFILE = [
  [0, 0],
  [0.2, 0.015],
  [0.29, 0.09],
  [0.33, 0.24],
  [0.32, 0.36],
  [0.27, 0.46],
  [0.2, 0.54],
  [0.13, 0.61],
  [0.12, 0.67],
  [0.08, 0.72],
  [0, 0.74],
].map(([x, y]) => new THREE.Vector2(x, y));
const WEIGHING_CENTER: [number, number] = [
  cad.E06.bounds[3] - 1.2,
  (cad.E06.bounds[2] + cad.E06.bounds[5]) / 2 - 3,
];
const WEIGHING_SCALE = 1.2;
const WEIGHING_HALF = (1.18 * WEIGHING_SCALE) / 2 + 0.5;
function WeighingStation() {
  return (
    <group
      position={[WEIGHING_CENTER[0], 1.19, WEIGHING_CENTER[1]]}
      scale={WEIGHING_SCALE}
    >
      <mesh position={[0, 0.09, 0]}>
        <boxGeometry args={[1.18, 0.18, 1.18]} />
        <meshStandardMaterial
          color="#24455c"
          metalness={0.5}
          roughness={0.45}
        />
      </mesh>
      {[
        [-0.46, -0.46],
        [0.46, -0.46],
        [-0.46, 0.46],
        [0.46, 0.46],
      ].map(([x, z]) => (
        <mesh key={`${x}-${z}`} position={[x, 0.025, z]}>
          <cylinderGeometry args={[0.07, 0.09, 0.05, 12]} />
          <meshStandardMaterial
            color="#0d2030"
            metalness={0.6}
            roughness={0.35}
          />
        </mesh>
      ))}
      <mesh position={[0, 0.24, 0]}>
        <boxGeometry args={[1.02, 0.08, 1.02]} />
        <meshStandardMaterial
          color="#9fc3d6"
          metalness={0.6}
          roughness={0.32}
        />
      </mesh>
      <mesh position={[0, 0.29, 0]}>
        <boxGeometry args={[0.86, 0.02, 0.86]} />
        <meshStandardMaterial
          color="#d9a93c"
          metalness={0.35}
          roughness={0.55}
        />
      </mesh>
      <mesh position={[-0.47, 0.58, -0.39]}>
        <cylinderGeometry args={[0.035, 0.045, 0.75, 8]} />
        <meshStandardMaterial
          color="#33607a"
          metalness={0.55}
          roughness={0.4}
        />
      </mesh>
      <group position={[-0.47, 1.02, -0.39]} rotation={[0, -0.35, 0]}>
        <mesh>
          <boxGeometry args={[0.36, 0.24, 0.11]} />
          <meshStandardMaterial
            color="#0c2233"
            metalness={0.3}
            roughness={0.5}
          />
        </mesh>
        <mesh position={[0, 0.02, 0.058]}>
          <planeGeometry args={[0.27, 0.14]} />
          <meshStandardMaterial
            color="#6fe6ff"
            emissive="#2fa9d8"
            emissiveIntensity={0.7}
            roughness={0.3}
          />
        </mesh>
      </group>
      <mesh position={[0.08, 0.29, 0.06]}>
        <latheGeometry args={[BAG_PROFILE, 24]} />
        <meshStandardMaterial
          color="#c7b08a"
          roughness={0.98}
          metalness={0.01}
        />
      </mesh>
      <mesh position={[0.08, 0.965, 0.06]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.118, 0.014, 6, 14]} />
        <meshStandardMaterial color="#6f5c3f" roughness={0.9} />
      </mesh>
    </group>
  );
}

function WeighingZone() {
  const points = useMemo(() => {
    const [x, z] = WEIGHING_CENTER;
    const y = 1.19;
    return [
      [x - WEIGHING_HALF, y, z - WEIGHING_HALF],
      [x + WEIGHING_HALF, y, z - WEIGHING_HALF],
      [x + WEIGHING_HALF, y, z + WEIGHING_HALF],
      [x - WEIGHING_HALF, y, z + WEIGHING_HALF],
      [x - WEIGHING_HALF, y, z - WEIGHING_HALF],
    ] as Point[];
  }, []);
  return (
    <>
      <Line
        points={points}
        color="#f7c948"
        lineWidth={2}
        transparent
        opacity={0.9}
        depthWrite={false}
      />
    </>
  );
}

const ARROW_SHAPE = (() => {
  const shape = new THREE.Shape();
  shape.moveTo(0.72, 0.12);
  shape.lineTo(0, 0.12);
  shape.lineTo(0, 0.3);
  shape.lineTo(-0.56, 0);
  shape.lineTo(0, -0.3);
  shape.lineTo(0, -0.12);
  shape.lineTo(0.72, -0.12);
  shape.closePath();
  return new THREE.ShapeGeometry(shape);
})();
function EntranceFlowArrow() {
  const group = useRef<THREE.Group>(null);
  const material = useRef<THREE.MeshBasicMaterial>(null);
  const start = cad.E06.bounds[3] + 3.1;
  const z = (cad.E06.bounds[2] + cad.E06.bounds[5]) / 2;
  useFrame(({ clock }) => {
    const phase = (clock.elapsedTime * 0.55) % 1;
    if (group.current) group.current.position.x = -phase * 1.4;
    if (material.current) material.current.opacity = Math.sin(phase * Math.PI);
  });
  return (
    <group position={[start, 1.17, z]}>
      <group ref={group}>
        <mesh
          geometry={ARROW_SHAPE}
          rotation={[-Math.PI / 2, 0, 0]}
          renderOrder={2}
        >
          <meshBasicMaterial
            ref={material}
            color="#f7c948"
            transparent
            opacity={0.9}
            depthWrite={false}
            toneMapped={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      </group>
    </group>
  );
}

const MANUAL_ROUTE_Y = 1.19;
const MANUAL_LANE_Y = 1.175;
const MANUAL_LANE_HALF_WIDTH = 0.95;
const MANUAL_LANE_LABEL = "人工转运通道";
const MANUAL_LANE_LABEL_STYLE: CSSProperties = {
  color: "#ffd34d",
  textShadow: "0 1px 3px rgba(0, 0, 0, 0.85)",
  font: '600 18px/1.2 "Microsoft YaHei", "PingFang SC", sans-serif',
  whiteSpace: "nowrap",
  pointerEvents: "none",
  userSelect: "none",
};
const MANUAL_ROUTE_LENGTH = MANUAL_PATH.slice(1).reduce((sum, point, index) => {
  const prev = MANUAL_PATH[index];
  return sum + Math.hypot(point[0] - prev[0], point[2] - prev[2]);
}, 0);
const MANUAL_ARROW_COUNT = Math.max(3, Math.round(MANUAL_ROUTE_LENGTH / 4.5));
const MANUAL_ARROW_GEOMETRY = ARROW_SHAPE.clone().rotateX(-Math.PI / 2);
const MANUAL_ARROW_TRANSFORMS = Array.from(
  { length: MANUAL_ARROW_COUNT },
  (_, index) => {
    const progress = (index + 0.5) / MANUAL_ARROW_COUNT;
    const point = along(MANUAL_PATH, progress);
    const ahead = along(MANUAL_PATH, Math.min(1, progress + 0.01));
    return {
      position: [point[0], MANUAL_ROUTE_Y, point[2]] as Point,
      yaw: Math.atan2(ahead[2] - point[2], -(ahead[0] - point[0])),
    };
  },
);
function offsetManualPath(offset: number): Point[] {
  return MANUAL_PATH.map((point, index) => {
    const prev = MANUAL_PATH[Math.max(0, index - 1)];
    const next = MANUAL_PATH[Math.min(MANUAL_PATH.length - 1, index + 1)];
    const inX = point[0] - prev[0];
    const inZ = point[2] - prev[2];
    const outX = next[0] - point[0];
    const outZ = next[2] - point[2];
    const inLength = Math.hypot(inX, inZ);
    const outLength = Math.hypot(outX, outZ);
    const inNormalX = inLength ? -inZ / inLength : 0;
    const inNormalZ = inLength ? inX / inLength : 0;
    const outNormalX = outLength ? -outZ / outLength : 0;
    const outNormalZ = outLength ? outX / outLength : 0;
    let miterX = inNormalX + outNormalX;
    let miterZ = inNormalZ + outNormalZ;
    const miterLength = Math.hypot(miterX, miterZ) || 1;
    miterX /= miterLength;
    miterZ /= miterLength;
    const dot =
      miterX * inNormalX + miterZ * inNormalZ ||
      miterX * outNormalX + miterZ * outNormalZ;
    const scale = offset / Math.max(0.2, Math.abs(dot));
    return [
      point[0] + miterX * scale,
      MANUAL_LANE_Y,
      point[2] + miterZ * scale,
    ] as Point;
  });
}
const MANUAL_LANE_SIDES = [
  offsetManualPath(MANUAL_LANE_HALF_WIDTH),
  offsetManualPath(-MANUAL_LANE_HALF_WIDTH),
];
const MANUAL_LANE_GEOMETRY = (() => {
  const [left, right] = MANUAL_LANE_SIDES;
  const positions: number[] = [];
  const indices: number[] = [];
  left.forEach((point, index) => {
    positions.push(point[0], MANUAL_LANE_Y, point[2]);
    positions.push(right[index][0], MANUAL_LANE_Y, right[index][2]);
    if (index < left.length - 1) {
      const base = index * 2;
      indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setIndex(indices);
  return geometry;
})();
const MANUAL_LANE_LABEL_POSITION: Point = [
  (MANUAL_PATH[1][0] + MANUAL_PATH[2][0]) / 2,
  MANUAL_ROUTE_Y,
  (MANUAL_PATH[1][2] + MANUAL_PATH[2][2]) / 2,
];
function ManualTransferRoute({
  simulation,
  paths,
}: Pick<Props, "simulation" | "paths">) {
  const arrows = useRef<THREE.InstancedMesh>(null);
  const lane = useRef<THREE.Group>(null);
  const label = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!arrows.current) return;
    const dummy = new THREE.Object3D();
    MANUAL_ARROW_TRANSFORMS.forEach(({ position, yaw }, index) => {
      dummy.position.set(...position);
      dummy.rotation.set(0, yaw, 0);
      dummy.scale.setScalar(0.55);
      dummy.updateMatrix();
      arrows.current!.setMatrixAt(index, dummy.matrix);
    });
    arrows.current.instanceMatrix.needsUpdate = true;
  }, []);
  useFrame(() => {
    const active = simulation.current.job?.phase === "MANUAL_TRANSFER";
    const visible = paths || active;
    if (lane.current) lane.current.visible = visible;
    if (label.current) label.current.style.display = visible ? "" : "none";
  });
  return (
    <group ref={lane} visible={false}>
      <mesh geometry={MANUAL_LANE_GEOMETRY} renderOrder={1}>
        <meshBasicMaterial
          color="#e9bf75"
          transparent
          opacity={0.16}
          depthWrite={false}
          toneMapped={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      {MANUAL_LANE_SIDES.map((points, index) => (
        <Line
          key={index}
          points={points}
          color="#e9bf75"
          lineWidth={2}
          dashed
          dashSize={0.5}
          gapSize={0.35}
          transparent
          opacity={0.85}
          depthWrite={false}
        />
      ))}
      <Html
        position={MANUAL_LANE_LABEL_POSITION}
        rotation={[-Math.PI / 2, 0, Math.PI / 2]}
        transform
      >
        <span ref={label} style={MANUAL_LANE_LABEL_STYLE}>
          {MANUAL_LANE_LABEL}
        </span>
      </Html>
      <instancedMesh
        ref={arrows}
        args={[undefined, undefined, MANUAL_ARROW_COUNT]}
        geometry={MANUAL_ARROW_GEOMETRY}
        frustumCulled={false}
        renderOrder={2}
      >
        <meshBasicMaterial
          color="#e9bf75"
          transparent
          opacity={0.9}
          depthWrite={false}
          toneMapped={false}
          side={THREE.DoubleSide}
        />
      </instancedMesh>
    </group>
  );
}

const BALER_DOOR_TRAVEL = 1.63;
function Plant({
  selected,
  view,
  xray,
  paths,
  shell,
  simulation,
  onLoad,
}: Pick<
  Props,
  "selected" | "view" | "xray" | "paths" | "shell" | "simulation"
> & {
  onLoad: (text: string) => void;
}) {
  const [model, setModel] = useState<THREE.Group | null>(null);
  const roots = useRef(new Map<string, THREE.Object3D>());
  const balerDoor = useRef<THREE.Group | null>(null);
  useFrame((_, delta) => {
    if (!balerDoor.current) return;
    const closed = simulation.current.job?.phase === "COMPRESSING";
    balerDoor.current.position.y = THREE.MathUtils.damp(
      balerDoor.current.position.y,
      closed ? -BALER_DOOR_TRAVEL : 0,
      8,
      delta,
    );
  });
  useEffect(() => {
    let cancelled = false;
    let loaded: THREE.Group | null = null;
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    loader.load(
      new URL("./actual-assets/plant-review.glb", document.baseURI).href,
      (gltf) => {
        loaded = gltf.scene;
        if (cancelled) return;
        let batched: THREE.Group;
        try {
          const door = extractBalerDoor(gltf.scene);
          batched = batchPlant(gltf.scene);
          if (door) {
            const baler = batched.getObjectByName("E13");
            if (baler) {
              baler.add(door);
              balerDoor.current = door;
            }
          }
        } catch {
          onLoad("CAD 解析失败，请检查本地模型；仿真与面板仍可操作。");
          return;
        }
        loaded = batched;
        // Materials are cloned per equipment instance; the original animation shares no objects.
        batched.traverse((object) => {
          if (!/^E\d{2}$/.test(object.name)) return;
          roots.current.set(object.name, object);
          const materials = new Map<string, THREE.MeshStandardMaterial>();
          object.traverse((child) => {
            if (!(child instanceof THREE.Mesh)) return;
            const originals = Array.isArray(child.material)
              ? child.material
              : [child.material];
            const copies = originals.map((original) => {
              if (!materials.has(original.uuid)) {
                const copy = original.clone();
                if (copy instanceof THREE.MeshStandardMaterial) {
                  copy.color.copy(deviceTone(copy.color));
                  copy.metalness = THREE.MathUtils.clamp(
                    copy.metalness * 0.6 + 0.32,
                    0.32,
                    0.75,
                  );
                  copy.roughness = THREE.MathUtils.clamp(
                    copy.roughness * 0.85 + 0.08,
                    0.34,
                    0.85,
                  );
                  copy.emissive.set("#07263d");
                  copy.emissiveIntensity = 0.08;
                }
                materials.set(original.uuid, copy);
              }
              return materials.get(original.uuid)!;
            });
            child.material = Array.isArray(child.material) ? copies : copies[0];
          });
        });
        setModel(batched);
        onLoad("已加载真实 CAD · 17 个设备已对应");
      },
      (progress) => {
        if (!cancelled && progress.total)
          onLoad(
            `正在加载真实 CAD ${Math.round((progress.loaded / progress.total) * 100)}%`,
          );
      },
      () => {
        if (!cancelled)
          onLoad(
            "CAD 加载失败，请检查 actual-assets/plant-review.glb；仿真与数据面板仍可使用。",
          );
      },
    );
    return () => {
      cancelled = true;
      if (loaded)
        loaded.traverse((object) => {
          if (object instanceof THREE.Mesh) {
            object.geometry.dispose();
            (Array.isArray(object.material)
              ? object.material
              : [object.material]
            ).forEach((material) => material.dispose());
          }
        });
    };
  }, [onLoad]);
  useEffect(() => {
    if (!model) return;
    for (const [id, root] of roots.current) {
      root.visible = id === "E01" ? shell : id !== REPLACED_ID;
      if (id === "E01") {
        root.scale.set(SHELL_SCALE, SHELL_SCALE_Y, SHELL_SCALE);
        root.position.set(...SHELL_POSITION);
      } else if (PARTITION_IDS.includes(id))
        root.position.set(0, 0, PARTITION_OFFSET_Z[id]);
      else {
        const offset = UNMOVED_IDS.has(id)
          ? ([0, 0, 0] as Point)
          : MODEL_OFFSET;
        root.position.set(
          offset[0],
          offset[1] + (id === "E01" ? SHELL_Y_OFFSET : 0),
          offset[2],
        );
      }
      const isSelected = view === "focus" && id === selected;
      const stock = ["E02", "E03", "E04", "E05"].includes(id);
      const faded = (xray || paths) && id !== "E01";
      root.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        if (id === "E01") {
          object.geometry.computeBoundingBox();
          const box = object.geometry.boundingBox;
          if (box)
            object.visible = box.max.y - box.min.y > 0.05 || box.max.y > 2;
        }
        for (const material of Array.isArray(object.material)
          ? object.material
          : [object.material]) {
          const opacity = isSelected
            ? 0.35
            : faded
              ? stock
                ? 0.16
                : paths
                  ? 0.3
                  : 0.78
              : 1;
          material.transparent = opacity < 1;
          material.opacity = opacity;
          material.depthWrite = !material.transparent;
          if (material instanceof THREE.MeshStandardMaterial) {
            material.emissive.set(isSelected ? "#0e5f7a" : "#07263d");
            material.emissiveIntensity = isSelected ? 0.42 : 0.08;
            material.roughness = Math.max(0.45, material.roughness);
          }
        }
      });
    }
  }, [model, xray, paths, shell, selected, view]);
  if (!model) return null;
  return <primitive object={model} />;
}

function Bottles({ simulation }: Pick<Props, "simulation">) {
  const body = useRef<THREE.InstancedMesh>(null),
    neck = useRef<THREE.InstancedMesh>(null);
  const dummy = useRef(new THREE.Object3D()),
    color = useRef(new THREE.Color()),
    direction = useRef(new THREE.Vector3());
  const up = useRef(new THREE.Vector3(0, 1, 0));
  useFrame(() => {
    if (!body.current || !neck.current) return;
    let index = 0;
    for (const unit of simulation.current.units) {
      if (unit.stage !== "moving" || index >= 2048) continue;
      const route = ROUTES[unit.route],
        p = along(route.points, unit.progress);
      const before = along(route.points, Math.max(0, unit.progress - 0.01));
      const after = along(route.points, Math.min(1, unit.progress + 0.01));
      direction.current.set(
        after[0] - before[0],
        after[1] - before[1],
        after[2] - before[2],
      );
      if (direction.current.lengthSq() < 0.00001)
        direction.current.set(1, 0, 0);
      direction.current.normalize();
      const spread = ((unit.id % 3) - 1) * (route.mode === "air" ? 0.04 : 0.15);
      p[0] += direction.current.z * spread;
      p[2] -= direction.current.x * spread;
      if (route.mode === "screw") {
        p[0] += Math.cos(unit.progress * 28) * 0.08;
        p[1] += Math.sin(unit.progress * 28) * 0.08;
      }
      dummy.current.position.set(...p);
      dummy.current.quaternion.setFromUnitVectors(
        up.current,
        direction.current,
      );
      dummy.current.updateMatrix();
      body.current.setMatrixAt(index, dummy.current.matrix);
      dummy.current.position.addScaledVector(direction.current, 0.161);
      dummy.current.updateMatrix();
      neck.current.setMatrixAt(index, dummy.current.matrix);
      color.current.set(MATERIALS[unit.grade].color);
      body.current.setColorAt(index, color.current);
      neck.current.setColorAt(index, color.current);
      index += 1;
    }
    for (const mesh of [body.current, neck.current]) {
      mesh.count = index;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  });
  return (
    <>
      <instancedMesh
        ref={body}
        args={[undefined, undefined, 2048]}
        frustumCulled={false}
        renderOrder={4}
      >
        <capsuleGeometry args={[0.0805, 0.168, 3, 8]} />
        <meshStandardMaterial
          roughness={0.25}
          metalness={0.06}
          emissive="#ffffff"
          emissiveIntensity={0.15}
        />
      </instancedMesh>
      <instancedMesh
        ref={neck}
        args={[undefined, undefined, 2048]}
        frustumCulled={false}
        renderOrder={4}
      >
        <cylinderGeometry args={[0.0315, 0.049, 0.084, 6]} />
        <meshStandardMaterial roughness={0.3} />
      </instancedMesh>
    </>
  );
}

const SILOS = ["E02", "E03", "E04", "E05"] as const;
function SiloContents({ simulation }: Pick<Props, "simulation">) {
  const fills = useRef(new Map<string, THREE.Mesh>()),
    gates = useRef(new Map<string, THREE.Mesh>());
  useFrame(() => {
    const state = simulation.current;
    for (const id of SILOS) {
      const mesh = fills.current.get(id),
        gate = gates.current.get(id);
      const amount = state.stocks[id].length,
        p = center(id);
      if (mesh) {
        const height = Math.max(0.04, (amount / CAPACITY) * 3.7);
        mesh.scale.y = height;
        mesh.position.set(p[0], 2.85 + height / 2, p[2]);
        mesh.visible = amount > 0;
      }
      if (gate) gate.position.x = p[0] + (openGate(state) === id ? 0.7 : 0);
    }
  });
  return (
    <>
      {SILOS.map((id) => {
        const p = center(id),
          color =
            id === "E04"
              ? MATERIALS["3A"].color
              : id === "E05"
                ? MATERIALS.MIXED.color
                : id === "E03"
                  ? "#e9bf75"
                  : "#4bd6ff";
        return (
          <group key={id}>
            <mesh
              ref={(node) => {
                if (node) fills.current.set(id, node);
              }}
              renderOrder={2}
            >
              <boxGeometry args={[3.35, 1, 3.35]} />
              <meshStandardMaterial
                color={color}
                transparent
                opacity={0.8}
                roughness={0.9}
              />
            </mesh>
            {(id === "E04" || id === "E05") && (
              <mesh
                ref={(node) => {
                  if (node) gates.current.set(id, node);
                }}
                position={[p[0], 2.24, 11.3]}
                renderOrder={3}
              >
                <boxGeometry args={[1, 0.08, 0.8]} />
                <meshStandardMaterial
                  color={color}
                  metalness={0.5}
                  roughness={0.4}
                />
              </mesh>
            )}
          </group>
        );
      })}
    </>
  );
}

function DeltaRobot({ simulation }: Pick<Props, "simulation">) {
  const bars = useRef<(THREE.Mesh | null)[]>([]),
    gripper = useRef<THREE.Mesh>(null);
  const start = useRef(new THREE.Vector3()),
    end = useRef(new THREE.Vector3()),
    direction = useRef(new THREE.Vector3());
  const up = useRef(new THREE.Vector3(0, 1, 0));
  useFrame(() => {
    const unit = simulation.current.units.find(
      (unit) =>
        unit.stage === "moving" &&
        (unit.route === "robotGreen" || unit.route === "robotBrown"),
    );
    const returning = simulation.current.armReturn;
    const drop = returning ? smallPosition(returning.grade) : null;
    const point: Point = unit
      ? along(ROUTES[unit.route].points, unit.progress)
      : returning && drop
        ? along(
            [
              [drop[0], 1.9, drop[2]],
              [drop[0], 2.9, 5.9],
              [-4.475, 2.35, 5.329],
            ],
            returning.progress,
          )
        : [-4.475, 2.35, 5.329];
    end.current.set(...point);
    if (gripper.current) gripper.current.position.copy(end.current);
    bars.current.forEach((bar, index) => {
      if (!bar) return;
      const angle = (index * Math.PI * 2) / 3;
      start.current.set(
        -4.475 + Math.cos(angle) * 0.7,
        3.45,
        5.329 + Math.sin(angle) * 0.7,
      );
      direction.current.copy(end.current).sub(start.current);
      bar.position.copy(start.current).add(end.current).multiplyScalar(0.5);
      bar.scale.y = direction.current.length();
      bar.quaternion.setFromUnitVectors(
        up.current,
        direction.current.normalize(),
      );
    });
  });
  return (
    <group>
      {[0, 1, 2].map((i) => (
        <mesh
          key={i}
          ref={(node) => {
            bars.current[i] = node;
          }}
          renderOrder={3}
        >
          <cylinderGeometry args={[0.035, 0.035, 1, 6]} />
          <meshStandardMaterial
            color="#59d7ff"
            metalness={0.55}
            roughness={0.3}
          />
        </mesh>
      ))}
      <mesh ref={gripper} renderOrder={4}>
        <boxGeometry args={[0.3, 0.1, 0.28]} />
        <meshStandardMaterial color="#0b2b3d" />
      </mesh>
    </group>
  );
}

function Worker({
  position,
  simulation,
}: {
  position: Point;
  simulation: ActualSimulation;
}) {
  const arm = useRef<THREE.Group>(null);
  useFrame(() => {
    if (arm.current)
      arm.current.rotation.z =
        Math.sin(simulation.current.motion.E14 * 3) * 0.5;
  });
  return (
    <group position={position}>
      <mesh position={[0, 1.45, 0]}>
        <sphereGeometry args={[0.17, 10, 8]} />
        <meshStandardMaterial color="#e2c4aa" />
      </mesh>
      <mesh position={[0, 0.98, 0]}>
        <boxGeometry args={[0.4, 0.58, 0.26]} />
        <meshStandardMaterial color="#d9a94e" />
      </mesh>
      {[-0.12, 0.12].map((x) => (
        <mesh key={x} position={[x, 0.35, 0]}>
          <boxGeometry args={[0.14, 0.7, 0.16]} />
          <meshStandardMaterial color="#26485e" />
        </mesh>
      ))}
      <group ref={arm} position={[0.24, 1.15, 0]}>
        <mesh position={[0.2, -0.1, 0]} rotation={[0, 0, -0.9]}>
          <boxGeometry args={[0.12, 0.52, 0.12]} />
          <meshStandardMaterial color="#e2c4aa" />
        </mesh>
      </group>
    </group>
  );
}

const STACKING_PICKUP_TIME = 0.6;
const STACKING_PLACE_TIME = 0.8;
const STACKING_WALK_TIME = 8.7;
const STACKING_GAP_TIME = 0.6;
const STACKING_ACTIVE_TIME =
  STACKING_PICKUP_TIME + STACKING_WALK_TIME + STACKING_PLACE_TIME;
const STACKING_TRIP_TIME = STACKING_ACTIVE_TIME + STACKING_GAP_TIME;
const STACKING_PICKUP: Point = [
  7.5 + MODEL_OFFSET[0],
  1.2,
  2.2 + MODEL_OFFSET[2],
];
const STACKING_LANE_X = 8 + MODEL_OFFSET[0];
const STACKING_SPOTS = (() => {
  let seed = 20261106;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const zones: typeof STORAGE_ZONES = [];
  const pool = [...STORAGE_ZONES];
  while (zones.length < 12) {
    if (!pool.length) pool.push(...STORAGE_ZONES);
    const index = Math.floor(random() * pool.length);
    zones.push(pool.splice(index, 1)[0]);
  }
  return zones.map((zone) => {
    const front = STORAGE_START_Z - zone.bay * STORAGE_BAY_WIDTH;
    const x =
      random() < 0.5 ? STORAGE_MIN_X + 0.6 : STORAGE_MAX_X - 0.6;
    const z = front - 1 - random() * (STORAGE_BAY_WIDTH - 2);
    const path: Point[] = [
      STACKING_PICKUP,
      [STACKING_LANE_X, 1.2, STACKING_PICKUP[2]],
      [STACKING_LANE_X, 1.2, z],
      [x - 0.46, 1.2, z],
    ];
    return { x, z, path };
  });
})();
function stackingTrips(bales: { id: number; at: number; grade: Grade }[]) {
  const trips: {
    baleId: number;
    grade: Grade;
    start: number;
    spot: (typeof STACKING_SPOTS)[number];
  }[] = [];
  let cursor = 0;
  for (const bale of bales) {
    if (trips.length >= STACKING_SPOTS.length) break;
    const spot = STACKING_SPOTS[trips.length % STACKING_SPOTS.length];
    const start = Math.max(cursor, bale.at);
    if (start + STACKING_ACTIVE_TIME > PLAYBACK_HORIZON) break;
    trips.push({ baleId: bale.id, grade: bale.grade, start, spot });
    cursor = start + STACKING_TRIP_TIME;
  }
  return trips;
}
function PostBalerStacking({ simulation }: Pick<Props, "simulation">) {
  const worker = useRef<THREE.Group>(null);
  const carried = useRef<THREE.Mesh>(null);
  const carriedMaterial = useRef<THREE.MeshStandardMaterial>(null);
  const stacks = useRef<THREE.InstancedMesh>(null);
  const dummy = useRef(new THREE.Object3D());
  const color = useRef(new THREE.Color());
  useFrame(() => {
    if (!worker.current || !carried.current || !stacks.current) return;
    const state = simulation.current;
    const trips = stackingTrips(state.bales);
    let completed = 0;
    while (
      completed < trips.length &&
      state.time >= trips[completed].start + STACKING_ACTIVE_TIME
    )
      completed += 1;
    for (let index = 0; index < completed; index += 1) {
      const trip = trips[index];
      dummy.current.position.set(trip.spot.x, 1.49, trip.spot.z);
      dummy.current.rotation.set(0, 0, 0);
      dummy.current.scale.setScalar(1);
      dummy.current.updateMatrix();
      stacks.current.setMatrixAt(index, dummy.current.matrix);
      color.current.set(MATERIALS[trip.grade].color);
      stacks.current.setColorAt(index, color.current);
    }
    stacks.current.count = completed;
    stacks.current.instanceMatrix.needsUpdate = true;
    if (stacks.current.instanceColor)
      stacks.current.instanceColor.needsUpdate = true;
    if (state.time >= PLAYBACK_HORIZON) {
      worker.current.visible = false;
      return;
    }
    if (!trips.length) {
      worker.current.visible = false;
      return;
    }
    const trip = trips.find(
      (entry) =>
        state.time >= entry.start &&
        state.time < entry.start + STACKING_TRIP_TIME,
    );
    if (!trip) {
      worker.current.visible = true;
      worker.current.position.set(...STACKING_PICKUP);
      worker.current.rotation.y = -Math.PI / 2;
      carried.current.visible = false;
      return;
    }
    const local = state.time - trip.start;
    const walkEnd = STACKING_PICKUP_TIME + STACKING_WALK_TIME;
    const placeEnd = walkEnd + STACKING_PLACE_TIME;
    if (local >= placeEnd) {
      worker.current.visible = false;
      return;
    }
    worker.current.visible = true;
    let position: Point;
    let ahead: Point;
    if (local < STACKING_PICKUP_TIME) {
      position = trip.spot.path[0];
      ahead = trip.spot.path[1];
    } else if (local < walkEnd) {
      const progress = (local - STACKING_PICKUP_TIME) / STACKING_WALK_TIME;
      position = along(trip.spot.path, progress);
      ahead = along(trip.spot.path, Math.min(1, progress + 0.02));
      position[1] += Math.sin(progress * 42) * 0.03;
    } else {
      position = trip.spot.path[trip.spot.path.length - 1];
      ahead = position;
    }
    worker.current.position.set(...position);
    const dx = ahead[0] - position[0];
    const dz = ahead[2] - position[2];
    if (Math.hypot(dx, dz) > 0.001)
      worker.current.rotation.y = Math.atan2(dx, dz);
    const lowering =
      local < walkEnd
        ? 0
        : Math.min(1, (local - walkEnd) / STACKING_PLACE_TIME);
    carried.current.visible = local < placeEnd;
    carried.current.position.set(0, 1.02 - lowering * 0.72, 0.46);
    carriedMaterial.current?.color.set(MATERIALS[trip.grade].color);
  });
  return (
    <group>
      <group ref={worker} visible={false}>
        <Worker position={[0, 0, 0]} simulation={simulation} />
        <mesh ref={carried} position={[0, 1.02, 0.46]} visible={false}>
          <boxGeometry args={[0.72, 0.5, 0.62]} />
          <meshStandardMaterial
            ref={carriedMaterial}
            roughness={0.85}
            metalness={0.05}
          />
        </mesh>
      </group>
      <instancedMesh
        ref={stacks}
        args={[undefined, undefined, STACKING_SPOTS.length]}
        frustumCulled={false}
      >
        <boxGeometry args={[0.9, 0.65, 0.85]} />
        <meshStandardMaterial roughness={0.85} metalness={0.05} />
      </instancedMesh>
    </group>
  );
}

const FUNNEL_LABEL_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  padding: "1px 5px",
  borderRadius: 3,
  background: "rgba(9, 26, 34, 0.8)",
  border: "1px solid rgba(255, 255, 255, 0.9)",
  color: "#eaf4f7",
  font: '600 10px/1.4 "Microsoft YaHei", "PingFang SC", sans-serif',
  pointerEvents: "none",
  userSelect: "none",
  whiteSpace: "nowrap",
};
const MANUAL_GRADES = SMALL_GRADES.filter(
  (grade) => grade !== "GREEN" && grade !== "BROWN",
);
function SmallStocks({
  simulation,
  view,
}: Pick<Props, "simulation" | "view">) {
  const fills = useRef(new Map<string, THREE.Mesh>());
  useFrame(() => {
    for (const grade of SMALL_GRADES) {
      const mesh = fills.current.get(grade);
      if (mesh)
        mesh.scale.y = Math.max(
          0.03,
          (simulation.current.stocks[grade].length / 24) * 0.5,
        );
    }
  });
  return (
    <>
      {SMALL_GRADES.map((grade) => {
        const p = smallPosition(grade),
          manual = grade !== "GREEN" && grade !== "BROWN";
        return (
          <group key={grade} position={p} scale={manual ? 1.2 : 1}>
            <mesh position={[0, 0.28, 0]}>
              <boxGeometry args={[0.66, 0.56, 0.6]} />
              <meshStandardMaterial color="#3f708c" wireframe />
            </mesh>
            <mesh
              ref={(node) => {
                if (node) fills.current.set(grade, node);
              }}
              position={[0, 0.12, 0]}
            >
              <boxGeometry args={[0.6, 1, 0.54]} />
              <meshStandardMaterial color={MATERIALS[grade].color} />
            </mesh>
          </group>
        );
      })}
      {view !== "focus" &&
        MANUAL_GRADES.map((grade) => {
          const p = smallPosition(grade);
          return (
            <Html key={`label-${grade}`} position={[p[0], 4, p[2]]} center>
              <span style={FUNNEL_LABEL_STYLE}>
                <i
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: "50%",
                    background: MATERIALS[grade].color,
                    flexShrink: 0,
                  }}
                />
                {MATERIALS[grade].name}
              </span>
            </Html>
          );
        })}
      {[-4.8, -3.3, -1.9].map((z) => (
        <Worker key={z} position={[-4.25, 3.25, z]} simulation={simulation} />
      ))}
    </>
  );
}

function Packing({ simulation }: Pick<Props, "simulation">) {
  const platen = useRef<THREE.Mesh>(null),
    bales = useRef<THREE.InstancedMesh>(null),
    cart = useRef<THREE.Group>(null);
  const dummy = useRef(new THREE.Object3D()),
    color = useRef(new THREE.Color());
  useFrame(() => {
    const state = simulation.current,
      job = state.job;
    if (platen.current) {
      platen.current.visible = job?.phase === "COMPRESSING";
      platen.current.position.x =
        0.8 -
        (job?.phase === "COMPRESSING"
          ? Math.sin((job.elapsed / 6) * Math.PI) * 1.4
          : 0);
    }
    if (cart.current) {
      cart.current.visible = job?.phase === "MANUAL_TRANSFER";
      if (job?.phase === "MANUAL_TRANSFER")
        cart.current.position.set(...along(MANUAL_PATH, job.elapsed / 14));
    }
    if (!bales.current) return;
    const carried = new Set(
      stackingTrips(state.bales)
        .filter((trip) => state.time >= trip.start)
        .map((trip) => trip.baleId),
    );
    let index = 0;
    for (const bale of state.bales.slice(-24)) {
      if (carried.has(bale.id)) continue;
      const slot = bale.id % 24;
      const progress = Math.min(1, (state.time - bale.at) / 2);
      dummy.current.position.set(
        5.9 + progress * (1.2 + (slot % 3)),
        1.6 + Math.floor(slot / 6) * 0.7 * progress,
        1.85 + Math.floor((slot % 6) / 3) * 1.1 * progress,
      );
      dummy.current.updateMatrix();
      bales.current.setMatrixAt(index, dummy.current.matrix);
      color.current.set(MATERIALS[bale.grade].color);
      bales.current.setColorAt(index, color.current);
      index += 1;
    }
    bales.current.count = index;
    bales.current.visible = index > 0;
    bales.current.instanceMatrix.needsUpdate = true;
    if (bales.current.instanceColor)
      bales.current.instanceColor.needsUpdate = true;
  });
  return (
    <>
      <mesh ref={platen} position={[0.8, 2.1, 1.84]} renderOrder={3}>
        <boxGeometry args={[0.2, 1.2, 1.2]} />
        <meshStandardMaterial color="#57d8ff" metalness={0.5} />
      </mesh>
      <instancedMesh
        ref={bales}
        args={[undefined, undefined, 24]}
        frustumCulled={false}
        visible={false}
      >
        <boxGeometry args={[0.9, 0.65, 0.85]} />
        <meshStandardMaterial roughness={0.85} />
      </instancedMesh>
      <group ref={cart}>
        <mesh position={[0, 0.25, 0]}>
          <boxGeometry args={[0.9, 0.15, 1.2]} />
          <meshStandardMaterial color="#234a63" />
        </mesh>
        <mesh position={[0, 0.65, 0]}>
          <boxGeometry args={[0.75, 0.7, 0.9]} />
          <meshStandardMaterial color="#d9a94e" />
        </mesh>
        <Worker position={[-0.7, 0, 0]} simulation={simulation} />
      </group>
    </>
  );
}

function EquipmentMotion({ simulation }: Pick<Props, "simulation">) {
  const slats = useRef<THREE.InstancedMesh>(null),
    rotor = useRef<THREE.Group>(null),
    screw = useRef<THREE.Group>(null);
  const dummy = useRef(new THREE.Object3D());
  useFrame(() => {
    const state = simulation.current;
    if (rotor.current) rotor.current.rotation.z = state.motion.E12 * 5;
    if (screw.current) screw.current.rotation.z = state.motion.E11 * 7;
    if (!slats.current) return;
    let index = 0;
    for (const id of [
      "feed",
      "manualIncline",
      "incline2",
      "chain",
      "robotBelt",
    ] as const) {
      const route = ROUTES[id],
        clock = state.motion[route.device];
      for (let slot = 0; slot < 12; slot += 1) {
        const progress = (slot / 12 + clock * 0.12) % 1;
        const p = along(route.points, progress),
          ahead = along(route.points, Math.min(1, progress + 0.01));
        dummy.current.position.set(p[0], p[1] - 0.18, p[2]);
        dummy.current.lookAt(ahead[0], ahead[1] - 0.18, ahead[2]);
        dummy.current.updateMatrix();
        slats.current.setMatrixAt(index++, dummy.current.matrix);
      }
    }
    slats.current.count = index;
    slats.current.instanceMatrix.needsUpdate = true;
  });
  return (
    <>
      <instancedMesh
        ref={slats}
        args={[undefined, undefined, 60]}
        frustumCulled={false}
        renderOrder={2}
      >
        <boxGeometry args={[0.58, 0.035, 0.08]} />
        <meshStandardMaterial color="#2e84a8" transparent opacity={0.65} />
      </instancedMesh>
      <group position={[-8.05, 2.85, -3.3]}>
        <group ref={rotor}>
          <mesh>
            <torusGeometry args={[0.36, 0.025, 6, 20]} />
            <meshStandardMaterial color="#5cd8ff" />
          </mesh>
          <mesh>
            <boxGeometry args={[0.68, 0.035, 0.035]} />
            <meshStandardMaterial color="#5cd8ff" />
          </mesh>
        </group>
      </group>
      <group position={[-7.415, 3.2, -7.5]} rotation={[-0.54, 0, 0]}>
        <group ref={screw}>
          <mesh>
            <torusGeometry args={[0.2, 0.025, 6, 16]} />
            <meshStandardMaterial color="#5cd8ff" />
          </mesh>
          <mesh>
            <boxGeometry args={[0.36, 0.025, 0.025]} />
            <meshStandardMaterial color="#5cd8ff" />
          </mesh>
        </group>
      </group>
    </>
  );
}

const FOCUS_OVERRIDES: Partial<
  Record<
    EquipmentId,
    { azimuth?: number; elevation?: number; distance?: number }
  >
> = {
  E06: { distance: 9.8 },
  E17: { distance: 8.4 },
  E11: { azimuth: -84.1, elevation: 24.7, distance: 15.1 },
  E07: { azimuth: 70.1, elevation: 44.2, distance: 16.4 },
  E14: { azimuth: 90.4, elevation: 23.3, distance: 22.6 },
  E12: { distance: 12.9 },
  E09: { distance: 9.3 },
  E18: { azimuth: -88.8, elevation: 23.8, distance: 9.8 },
  E16: { azimuth: -178.0, elevation: 34.3, distance: 10.5 },
  E15: { azimuth: 177, elevation: 31.7, distance: 10.1 },
  E08: { azimuth: 50.8, elevation: 22.3, distance: 10.7 },
  E10: { azimuth: 75.7, elevation: 31.4, distance: 20.9 },
  E13: { azimuth: 137.9, elevation: 18.6, distance: 16.1 },
};
function CameraRig({
  selected,
  view,
  readout,
}: Pick<Props, "selected" | "view"> & {
  readout: RefObject<HTMLDivElement | null>;
}) {
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null),
    clock = useRef(3),
    readoutClock = useRef(0);
  const desired = useRef(new THREE.Vector3()),
    target = useRef(new THREE.Vector3());
  const { camera, size } = useThree();
  const focusKey = view === "focus" && selected ? selected : "";
  useEffect(() => {
    const fit = Math.max(
      1,
      Math.min(1.5, size.height / Math.max(1, size.width)),
    );
    target.current.set(-2.5 + MODEL_OFFSET[0], 2.5, -0.4 + MODEL_OFFSET[2]);
    if (view === "focus" && selected) {
      const point = center(selected);
      target.current.set(
        point[0] + MODEL_OFFSET[0],
        point[1],
        point[2] + MODEL_OFFSET[2],
      );
      const b = cad[selected].bounds,
        span = Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
      let dx = target.current.x - (-2.5 + MODEL_OFFSET[0]);
      let dz = target.current.z - (-0.4 + MODEL_OFFSET[2]);
      const length = Math.hypot(dx, dz);
      if (length < 1e-4) {
        dx = 1;
        dz = 1;
      } else {
        dx /= length;
        dz /= length;
      }
      const override = FOCUS_OVERRIDES[selected];
      const baseDistance = Math.max(14, span * 3.2) * fit;
      let direction: THREE.Vector3;
      let distance = override?.distance ?? baseDistance * Math.sqrt(1.36);
      if (override?.azimuth !== undefined && override.elevation !== undefined) {
        const azimuth = THREE.MathUtils.degToRad(override.azimuth);
        const elevation = THREE.MathUtils.degToRad(override.elevation);
        direction = new THREE.Vector3(
          Math.sin(azimuth) * Math.cos(elevation),
          Math.sin(elevation),
          Math.cos(azimuth) * Math.cos(elevation),
        );
      } else direction = new THREE.Vector3(dx, 0.6, dz).normalize();
      desired.current
        .copy(target.current)
        .add(direction.multiplyScalar(distance));
    } else
      desired.current
        .copy(target.current)
        .add(
          view === "top"
            ? new THREE.Vector3(0.01, 40 * fit, 0)
            : new THREE.Vector3(29, 29, 35)
                .normalize()
                .multiplyScalar(34 * fit),
        );
    clock.current = 0;
  }, [focusKey, view, size.width, size.height]);
  useFrame((_, delta) => {
    if (!controls.current) return;
    readoutClock.current += delta;
    if (readoutClock.current >= 0.1 && readout.current) {
      readoutClock.current = 0;
      const offset = camera.position.clone().sub(controls.current.target);
      const distance = offset.length();
      if (distance > 1e-6) {
        const azimuth = THREE.MathUtils.radToDeg(
          Math.atan2(offset.x, offset.z),
        );
        const elevation = THREE.MathUtils.radToDeg(
          Math.asin(THREE.MathUtils.clamp(offset.y / distance, -1, 1)),
        );
        const set = (role: string, value: string) => {
          const element = readout.current?.querySelector(
            `[data-role="${role}"]`,
          );
          if (element) element.textContent = value;
        };
        set("azimuth", `${azimuth.toFixed(1)}°`);
        set("elevation", `${elevation.toFixed(1)}°`);
        set("distance", `${distance.toFixed(1)} m`);
        set(
          "target",
          `${controls.current.target.x.toFixed(1)}, ${controls.current.target.y.toFixed(1)}, ${controls.current.target.z.toFixed(1)}`,
        );
      }
    }
    if (clock.current >= 2.8) return;
    clock.current += delta;
    const amount = 1 - Math.exp(-delta * 5);
    camera.position.lerp(desired.current, amount);
    controls.current.target.lerp(target.current, amount);
    controls.current.update();
  });
  return (
    <OrbitControls
      ref={controls}
      enableDamping
      minDistance={5}
      maxDistance={100}
      maxPolarAngle={Math.PI / 2.05}
      target={[-2.5 + MODEL_OFFSET[0], 2.5, -0.4 + MODEL_OFFSET[2]]}
      onStart={() => {
        clock.current = 3;
      }}
    />
  );
}

class SceneBoundary extends Component<
  { children: ReactNode; onError: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function LabelProjector({
  selected,
  view,
  elements,
}: Pick<Props, "selected" | "view"> & {
  elements: RefObject<Map<string, HTMLElement>>;
}) {
  const { camera, size } = useThree();
  const vector = useRef(new THREE.Vector3());
  useFrame(() => {
    const occupied: { x: number; y: number }[] = [];
    for (const [id, element] of elements.current) {
      let point: Point;
      if (SILOS.includes(id as (typeof SILOS)[number])) {
        element.hidden = view === "focus";
        if (element.hidden) continue;
        point = center(id as EquipmentId);
        point[1] = 7.3;
      } else {
        const grade = SMALL_GRADES.find((grade) => grade === id);
        if (!grade || (grade !== "GREEN" && grade !== "BROWN")) continue;
        element.hidden = selected !== "E15";
        if (element.hidden) continue;
        point = smallPosition(grade);
        point[1] += 0.9;
      }
      vector.current
        .set(point[0] + MODEL_OFFSET[0], point[1], point[2] + MODEL_OFFSET[2])
        .project(camera);
      if (
        vector.current.z < -1 ||
        vector.current.z > 1 ||
        Math.abs(vector.current.x) > 1.1 ||
        Math.abs(vector.current.y) > 1.1
      ) {
        element.hidden = true;
        continue;
      }
      const x = Math.max(
        55,
        Math.min(size.width - 55, ((vector.current.x + 1) / 2) * size.width),
      );
      let y = Math.max(70, ((1 - vector.current.y) / 2) * size.height);
      const direction = y < 120 ? 1 : -1;
      while (
        occupied.some((p) => Math.abs(p.x - x) < 100 && Math.abs(p.y - y) < 25)
      )
        y += direction * 27;
      y = Math.max(24, Math.min(size.height - 24, y));
      occupied.push({ x, y });
      element.style.left = `${x}px`;
      element.style.top = `${y}px`;
    }
  });
  return null;
}

const DEVICE_PIN_NAMES: Record<EquipmentId, string> = {
  E02: "三色中转",
  E03: "杂瓶中转",
  E04: "3A",
  E05: "杂色 PET",
  E06: "上料爬坡机",
  E07: "杂瓶爬坡机",
  E08: "输送带",
  E09: "脱标爬坡机",
  E10: "链板机",
  E11: "螺旋上料机",
  E12: "脱标机",
  E13: "打包机",
  E14: "人工分拣平台",
  E15: "并联机械手",
  E16: "机械手输送带",
  E17: "第一台分选机",
  E18: "第二台分选机",
};
function DevicePins({ selected, onSelect }: Pick<Props, "selected" | "onSelect">) {
  return (
    <>
      {EQUIPMENT_IDS.map((id) => {
        const [x, , z] = center(id);
        return (
          <Html
            key={id}
            position={[x, cad[id].bounds[4] + 0.55, z]}
            center
            zIndexRange={[12, 0]}
          >
            <div className="device-marker">
              <span className="device-marker-name">{DEVICE_PIN_NAMES[id]}</span>
              <button
                type="button"
                className="device-pin"
                aria-label={`选择 ${id} ${EQUIPMENT[id]}`}
                aria-pressed={selected === id}
                onClick={() => onSelect(id)}
              >
                <i />
              </button>
            </div>
          </Html>
        );
      })}
    </>
  );
}

export default function ActualScene(props: Props) {
  const [loadState, setLoadState] = useState("正在加载真实 CAD…");
  const elements = useRef(new Map<string, HTMLElement>());
  const cameraReadout = useRef<HTMLDivElement>(null);
  return (
    <div className="actual-scene">
      <Canvas
        camera={{ position: [26.5, 31.5, 33.6], fov: 38, near: 0.1, far: 300 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true, powerPreference: "high-performance" }}
        fallback={
          <p className="scene-error">
            浏览器不支持 WebGL；请使用设备列表和时间轴查看仿真。
          </p>
        }
      >
        <color attach="background" args={[SCENE_BLUE]} />
        <fog attach="fog" args={[SCENE_BLUE, 74, 172]} />
        <hemisphereLight args={["#d3efff", "#081726", 2.1]} />
        <directionalLight
          position={[18, 30, 12]}
          intensity={2.9}
          color="#eaf7ff"
        />
        <directionalLight
          position={[-20, 14, -18]}
          intensity={1.15}
          color="#4fb9ff"
        />
        <pointLight
          position={[-2, 13, 0]}
          intensity={110}
          distance={48}
          decay={2}
          color="#38c6ff"
        />
        <SceneBoundary
          onError={() => setLoadState("三维画面暂不可用，仿真与面板仍可操作。")}
        >
          <Plant {...props} onLoad={setLoadState} />
          <mesh
            rotation={[-Math.PI / 2, 0, 0]}
            position={[cad.E01.center[0], 1.16, cad.E01.center[2]]}
          >
            <planeGeometry args={[SHELL_WIDTH, SHELL_DEPTH]} />
            <meshStandardMaterial
              color="#0e2a40"
              roughness={0.84}
              metalness={0.32}
            />
          </mesh>
          <gridHelper
            args={[
              Math.max(SHELL_WIDTH, SHELL_DEPTH),
              Math.round(Math.max(SHELL_WIDTH, SHELL_DEPTH) / 2),
              "#2a7ba3",
              "#123a52",
            ]}
            position={[cad.E01.center[0], 1.17, cad.E01.center[2]]}
            material-transparent
            material-opacity={0.22}
            material-depthWrite={false}
          />
          <StorageZones />
          <PostBalerStacking simulation={props.simulation} />
          <group position={MODEL_OFFSET}>
            <EquipmentZones />
            {props.paths && <FlowPaths />}
            <ManualTransferRoute
              simulation={props.simulation}
              paths={props.paths}
            />
            <Bottles simulation={props.simulation} />
            <EntranceFlowArrow />
            <WeighingZone />
            <WeighingStation />
            <SiloContents {...props} />
            <DeltaRobot simulation={props.simulation} />
            <SmallStocks {...props} />
            <Packing simulation={props.simulation} />
            <EquipmentMotion simulation={props.simulation} />
            {props.view === "focus" && (
              <DevicePins
                selected={props.selected}
                onSelect={props.onSelect}
              />
            )}
          </group>
          <CameraRig
            selected={props.selected}
            view={props.view}
            readout={cameraReadout}
          />
          <LabelProjector
            selected={props.selected}
            view={props.view}
            elements={elements}
          />
        </SceneBoundary>
      </Canvas>
      <div className="actual-projected-labels">
        {SILOS.map((id) => (
          <span
            key={id}
            ref={(node) => {
              if (node) elements.current.set(id, node);
              else elements.current.delete(id);
            }}
            className="silo-label"
          >
            <i
              style={{
                background:
                  id === "E04"
                    ? MATERIALS["3A"].color
                    : id === "E05"
                      ? MATERIALS.MIXED.color
                      : id === "E03"
                        ? "#e9bf75"
                        : "#4bd6ff",
              }}
            />
            {id} ·{" "}
            {id === "E02"
              ? "三色中转"
              : id === "E03"
                ? "杂瓶中转"
                : id === "E04"
                  ? "3A"
                  : "杂色 PET"}
          </span>
        ))}
        {SMALL_GRADES.map((grade) => (
          <span
            key={grade}
            ref={(node) => {
              if (node) elements.current.set(grade, node);
              else elements.current.delete(grade);
            }}
            className="stock-label"
            hidden
          >
            {MATERIALS[grade].name}
          </span>
        ))}
      </div>
      <div className="camera-readout" ref={cameraReadout}>
        <span>
          方位角 <b data-role="azimuth">—</b>
        </span>
        <span>
          仰角 <b data-role="elevation">—</b>
        </span>
        <span>
          距离 <b data-role="distance">—</b>
        </span>
        <small>
          目标 <b data-role="target">—</b>
        </small>
      </div>
      <div className="model-status">
        <span />
        {loadState}
      </div>
    </div>
  );
}
