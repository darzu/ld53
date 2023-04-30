import { DBG_ASSERT } from "../flags.js";
import { vec2, vec3, vec4, quat, mat4, mat3, V } from "../sprig-matrix.js";
import { jitter } from "../math.js";
import {
  getAABBFromMesh,
  mapMeshPositions,
  mergeMeshes,
  Mesh,
  RawMesh,
  transformMesh,
  validateMesh,
} from "../render/mesh.js";
import { assert, assertDbg, range } from "../util.js";
import {
  centroid,
  quatFromUpForward,
  randNormalPosVec3,
  vec3Dbg,
} from "../utils-3d.js";
import {
  createEmptyMesh,
  createTimberBuilder,
  getBoardsFromMesh,
  verifyUnsharedProvokingForWood,
  reserveSplinterSpace,
  TimberBuilder,
  WoodState,
  setSideQuadIdxs,
  setEndQuadIdxs,
} from "../wood.js";
import { BLACK } from "../assets.js";
import { mkHalfEdgeQuadMesh } from "../primatives.js";
import { HFace, meshToHalfEdgePoly } from "../half-edge.js";
import { createGizmoMesh } from "../gizmos.js";
import { EM } from "../entity-manager.js";
import {
  PositionDef,
  updateFrameFromPosRotScale,
} from "../physics/transform.js";
import { RenderableConstructDef } from "../render/renderer-ecs.js";
import {
  createAABB,
  getSizeFromAABB,
  updateAABBWithPoint,
} from "../physics/aabb.js";

const numRibSegs = 8;

export interface HomeShip {
  timberState: WoodState;
  timberMesh: Mesh;
  // TODO(@darzu): how to pass this?
  ribCount: number;
  ribSpace: number;
  ribWidth: number;
  ceilHeight: number;
  floorHeight: number;
  floorLength: number;
  floorWidth: number;
}

export interface ShipyardUI {
  kind: "shipyard";
  ribCount: number;
  // TODO(@darzu): other params
}

// Note: Made w/ game-font !
const keelTemplate: Mesh = {
  pos: [
    V(0.58, 0.0, 1.49),
    V(-1.4, 0.0, 1.52),
    V(-1.38, 0.0, 1.74),
    V(0.59, 0.0, 1.71),
    V(-3.73, 0.0, 1.47),
    V(-3.72, 0.0, 1.68),
    V(-4.4, 0.0, 1.22),
    V(-4.64, 0.0, 1.41),
    V(-4.76, 0.0, 0.24),
    V(-5.03, 0.0, 0.3),
    V(-4.81, 0.0, -0.08),
    V(-5.13, 0.0, -0.04),
    V(-5.05, 0.0, -1.12),
    V(-5.38, 0.0, -1.09),
    V(2.36, 0.0, 1.46),
    V(2.28, 0.0, 1.26),
    V(3.63, 0.0, 1.07),
    V(3.5, 0.0, 0.89),
    V(4.51, 0.0, 0.49),
    V(4.32, 0.0, 0.37),
    V(5.15, 0.0, -0.4),
    V(4.93, 0.0, -0.44),
    V(5.29, 0.0, -1.46),
    V(5.06, 0.0, -1.46),
  ],
  tri: [],
  quad: [
    V(0, 1, 2, 3),
    V(4, 5, 2, 1),
    V(6, 7, 5, 4),
    V(8, 9, 7, 6),
    V(10, 11, 9, 8),
    V(12, 13, 11, 10),
    V(14, 15, 0, 3),
    V(16, 17, 15, 14),
    V(18, 19, 17, 16),
    V(20, 21, 19, 18),
    V(22, 23, 21, 20),
  ],
  colors: [
    V(0.49, 0.16, 0.86),
    V(0.48, 0.03, 0.88),
    V(0.47, 0.19, 0.86),
    V(0.53, 0.5, 0.68),
    V(0.34, 0.74, 0.58),
    V(0.62, 0.36, 0.69),
    V(0.93, 0.32, 0.19),
    V(0.57, 0.18, 0.8),
    V(0.67, 0.18, 0.72),
    V(0.19, 0.92, 0.34),
    V(0.42, 0.81, 0.42),
  ],
  surfaceIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  usesProvoking: true,
};
const __temp1 = vec3.create();
function getPathFrom2DQuadMesh(m: Mesh, up: vec3.InputT): Path {
  const hpoly = meshToHalfEdgePoly(m);

  // find the end face
  let endFaces = hpoly.faces.filter(isEndFace);
  // console.dir(endFaces);
  assert(endFaces.length === 2);
  const endFace =
    endFaces[0].edg.orig.vi < endFaces[1].edg.orig.vi
      ? endFaces[0]
      : endFaces[1];

  // find the end edge
  let endEdge = endFace.edg;
  while (!endEdge.twin.face) endEdge = endEdge.next;
  endEdge = endEdge.next.next;
  // console.log("endEdge");
  // console.dir(endEdge);

  // build the path
  const path: Path = [];
  let e = endEdge;
  while (true) {
    let v0 = m.pos[e.orig.vi];
    let v1 = m.pos[e.next.orig.vi];
    let pos = centroid(v0, v1);
    let dir = vec3.cross(vec3.sub(v0, v1, __temp1), up, __temp1);
    const rot = quatFromUpForward(quat.create(), up, dir);
    path.push({ pos, rot });

    if (!e.face) break;

    e = e.next.next.twin;
  }

  // console.log("path");
  // console.dir(path);

  return path;

  function isEndFace(f: HFace): boolean {
    let neighbor: HFace | undefined = undefined;
    let e = f.edg;
    for (let i = 0; i < 4; i++) {
      if (e.twin.face)
        if (!neighbor) neighbor = e.twin.face;
        else if (e.twin.face !== neighbor) return false;
      e = e.next;
    }
    return true;
  }
}

function createPathGizmos(path: Path): Mesh {
  let gizmos: Mesh[] = [];
  path.forEach((p) => {
    const g = createGizmoMesh();
    g.pos.forEach((v) => {
      vec3.transformQuat(v, p.rot, v);
      vec3.add(v, p.pos, v);
    });
    gizmos.push(g);
  });
  const res = mergeMeshes(...gizmos) as Mesh;
  res.usesProvoking = true;
  return res;
}
async function dbgPathWithGizmos(path: Path) {
  const mesh = createPathGizmos(path);

  const e = EM.new();
  EM.ensureComponentOn(e, PositionDef);
  EM.ensureComponentOn(e, RenderableConstructDef, mesh);
}

function snapXToPath(path: Path, x: number, out: vec3) {
  return snapToPath(path, x, 0, out);
}
const __temp2 = vec3.create();
function snapToPath(path: Path, w: number, dim: 0 | 1 | 2, out: vec3) {
  for (let i = 0; i < path.length; i++) {
    let pos = path[i].pos;
    // are we ahead of w
    if (w < pos[dim]) {
      if (i === 0) {
        // w is before the whole path
        vec3.copy(out, path[i].pos);
        return out;
      }
      let prev = path[i - 1].pos;
      assert(
        prev[dim] <= w,
        `TODO: we assume path is in assending [x,y,z][${dim}] order`
      );

      let diff = vec3.sub(pos, prev, __temp2);
      let percent = (w - prev[dim]) / diff[dim];
      vec3.add(prev, vec3.scale(diff, percent, out), out);
      return out;
    }
  }
  // the whole path is behind x
  vec3.copy(out, path[path.length - 1].pos);
  return out;
}

export function createHomeShip(): HomeShip {
  const _start = performance.now();
  const _timberMesh = createEmptyMesh("homeShip");

  const builder: TimberBuilder = createTimberBuilder(_timberMesh);

  // KEEL
  // TODO(@darzu): IMPL keel!
  const keelWidth = 0.7;
  const keelDepth = 1.2;
  builder.width = keelWidth;
  builder.depth = keelDepth;

  let keelPath: Path;
  {
    // const keelTempAABB = getAABBFromMesh(keelTemplate);
    // console.dir(keelTempAABB);
    let keelTemplate2 = transformMesh(
      keelTemplate,
      mat4.fromRotationTranslationScale(
        quat.rotateX(quat.identity(), Math.PI / 2),
        [0, 0, 0],
        // vec3.scale(vec3.negate(keelTempAABB.min), 6),
        [5, 5, 5]
      )
    ) as Mesh;

    keelPath = getPathFrom2DQuadMesh(keelTemplate2, [0, 0, 1]);

    // fix keel orientation
    // r->g, g->b, b->r
    fixPathBasis(keelPath, [0, 1, 0], [0, 0, 1], [1, 0, 0]);

    const tempAABB = createAABB();
    keelPath.forEach((p) => updateAABBWithPoint(tempAABB, p.pos));
    translatePath(keelPath, [0, -tempAABB.min[1], 0]);

    dbgPathWithGizmos(keelPath);
  }

  function fixPathBasis(
    path: Path,
    newX: vec3.InputT,
    newY: vec3.InputT,
    newZ: vec3.InputT
  ) {
    // TODO(@darzu): PERF. Must be a better way to do this...
    const fixRot = quat.fromMat3(
      mat3.fromValues(
        newX[0],
        newX[1],
        newX[2],
        newY[0],
        newY[1],
        newY[2],
        newZ[0],
        newZ[1],
        newZ[2]
      )
    );
    path.forEach((p) => quat.mul(p.rot, fixRot, p.rot));
  }

  const keelAABB = createAABB();
  keelPath.forEach((p) => updateAABBWithPoint(keelAABB, p.pos));
  const keelSize = getSizeFromAABB(keelAABB, vec3.create());

  appendBoard(builder.mesh, {
    path: keelPath,
    width: keelWidth,
    depth: keelDepth,
  });

  // RIBS
  const ribWidth = 0.5;
  const ribDepth = 0.4;
  builder.width = ribWidth;
  builder.depth = ribDepth;
  const ribCount = 12;
  // const ribSpace = 3;

  const keelLength = keelSize[0];

  const railHeight = keelAABB.max[1] - 1;
  const prowOverhang = 0.5;
  const prow = V(keelAABB.max[0] + prowOverhang, railHeight, 0);
  const sternOverhang = 1;
  const sternpost = V(keelAABB.min[0] - sternOverhang, railHeight, 0);
  const transomWidth = 12;
  const railLength = keelLength + prowOverhang + sternOverhang;

  const ribSpace = railLength / (ribCount + 1);
  // const ribSpace = (railLength - 2) / ribCount;

  let railCurve: BezierCubic;
  {
    const sternAngle = (1 * Math.PI) / 16;
    const sternInfluence = 24;
    const prowAngle = (4 * Math.PI) / 16;
    const prowInfluence = 12;
    const p0 = vec3.add(sternpost, [0, 0, transomWidth * 0.5], vec3.create());
    const p1 = vec3.add(
      p0,
      [
        Math.cos(sternAngle) * sternInfluence,
        0,
        Math.sin(sternAngle) * sternInfluence,
      ],
      vec3.create()
    );
    const p3 = prow;
    const p2 = vec3.add(
      p3,
      [
        -Math.cos(prowAngle) * prowInfluence,
        0,
        Math.sin(prowAngle) * prowInfluence,
      ],
      vec3.create()
    );

    railCurve = { p0, p1, p2, p3 };
  }
  const railNodes = ribCount + 2;
  const railPath = createPathFromBezier(railCurve, railNodes, [0, 1, 0]);
  fixPathBasis(railPath, [0, 1, 0], [0, 0, 1], [1, 0, 0]);

  // let ribEnds: vec3[] = [];
  let ribPaths: Path[] = [];
  let ribCurves: BezierCubic[] = [];
  for (let i = 0; i < ribCount; i++) {
    // const ribX = i * ribSpace + 2 + keelAABB.min[0];
    const ribX = i * ribSpace + ribSpace + keelAABB.min[0];
    const ribStart = snapXToPath(keelPath, ribX, vec3.create());

    // const p = translatePath(makeRibPath(i), V(i * ribSpace, 0, 0));
    // const weirdP = translatePath(makeRibPathWierd(i), ribStart);
    // if (i === 0) dbgPathWithGizmos(p);

    // TODO(@darzu): compute outboard with bezier curve
    // const outboard = (1 - Math.abs(i - ribCount / 2) / (ribCount / 2)) * 10;

    let ribCurve: BezierCubic;
    {
      const p0 = vec3.clone(ribStart);
      const p1 = vec3.add(p0, [0, 0, 5], vec3.create());
      // TODO(@darzu): HACKs for the first and last rib
      // if (i === 0) {
      //   p1[1] += 1;
      //   p1[2] -= 4;
      // }
      if (i === ribCount - 1) {
        p1[1] += 1;
        p1[2] -= 4;
      }
      const ribEnd = snapXToPath(railPath, ribStart[0], vec3.create());
      // ribEnds.push(ribEnd);

      const p3 = ribEnd;
      // const p3 = vec3.add(ribStart, [0, keelSize[1], outboard], vec3.create());
      const p2 = vec3.add(p3, [0, -5, 2], vec3.create());
      ribCurve = { p0, p1, p2, p3 };

      if (i === 0) {
        console.dir(railPath);
        console.log(vec3Dbg(ribStart));
        console.log(vec3Dbg(ribEnd));
        console.dir(ribCurve);
      }
    }
    ribCurves.push(ribCurve);

    const numRibSegs = 8;
    const bPath = createPathFromBezier(ribCurve, numRibSegs, [1, 0, 0]);
    fixPathBasis(bPath, [0, 1, 0], [0, 0, 1], [1, 0, 0]);
    ribPaths.push(bPath);

    if (i === 0) {
      console.log("RIB BEZIER PATH");
      // console.log(outboard);
      console.dir(ribCurve);
      console.dir(bPath);
      dbgPathWithGizmos(bPath);
      dbgPathWithGizmos(mirrorPath(clonePath(bPath), V(0, 0, 1)));
    }
    // if (i === 1) dbgPathWithGizmos(weirdP);

    appendBoard(builder.mesh, {
      path: bPath,
      width: ribWidth,
      depth: ribDepth,
    });

    appendBoard(builder.mesh, {
      path: mirrorPath(clonePath(bPath), V(0, 0, 1)),
      width: ribWidth,
      depth: ribDepth,
    });
  }

  // RAIL
  // fix rail spacing to match ribs
  for (let i = 0; i < ribCount; i++) {
    const railIdx = i + 1;
    const ribPath = ribPaths[i];
    const ribEnd = ribPath[ribPath.length - 1];
    // console.log(`${vec3Dbg(railPath[railIdx].pos)} vs ${ribEnd.pos}`);
    vec3.copy(railPath[railIdx].pos, ribEnd.pos);
    // railPath[railIdx].pos[0] = ribStarts[i][0];
    // railPath[railIdx].pos[2] = ribStarts[i][2];
  }
  // rail board:
  appendBoard(builder.mesh, {
    path: railPath,
    width: ribWidth,
    depth: ribDepth,
  });
  appendBoard(builder.mesh, {
    path: mirrorPath(clonePath(railPath), V(0, 0, 1)),
    width: ribWidth,
    depth: ribDepth,
  });

  translatePath(railPath, [0, 0, 8]);
  dbgPathWithGizmos(railPath);

  // PLANK PARAMS
  // const plankCount = 20;
  const plankWidth = 0.4;
  const plankDepth = 0.2;

  // RIBS W/ SLOTS
  const evenRibs: Path[] = [];
  let plankCount = 0;
  let longestRibIdx = 0;
  {
    let ribIdx = 0;
    for (let curve of ribCurves) {
      let topToBottomCurve = reverseBezier(curve);
      const even = createEvenPathFromBezier(
        topToBottomCurve,
        plankWidth * 2.0, // * 0.95,
        [1, 0, 0]
      );
      // even.reverse();
      // translatePath(even, [0, 0, 10]);
      fixPathBasis(even, [0, 0, 1], [0, 1, 0], [-1, 0, 0]);
      translatePathAlongNormal(even, ribDepth); // + 0.3);
      // fixPathBasis(even, [0, 1, 0], [1, 0, 0], [0, 0, -1]);
      dbgPathWithGizmos(even);
      // dbgPathWithGizmos([even[0]]);
      evenRibs.push(even);
      if (even.length > plankCount) {
        plankCount = even.length;
        longestRibIdx = ribIdx;
      }
      ribIdx++;
    }
  }
  console.log(`plankCount: ${plankCount}`);

  // PLANKS (take 2)
  // const centerRibP = ribPaths[longestRibIdx];
  // const centerRibC = ribCurves[longestRibIdx];
  // dbgPathWithGizmos(centerRibP);

  const sternKeelPath = keelPath.reduce(
    (p, n, i) => (i < 4 ? [...p, n] : p),
    [] as Path
  );
  const bowKeelPath = keelPath.reduce(
    (p, n, i) => (i >= keelPath.length - 4 ? [...p, n] : p),
    [] as Path
  );

  let transomPlankNum = evenRibs[0].length;

  const plankPaths: Path[] = [];
  const plankPathsMirrored: Path[] = [];
  const _temp4 = vec3.create();
  for (let i = 0; i < plankCount; i++) {
    const nodes: Path = evenRibs
      .filter((rib) => rib.length > i)
      .map((rib) => rib[i]);

    // one extra board to connect to the keel up front
    if (i < 20) {
      const secondToLast = nodes[nodes.length - 1];
      const last: PathNode = {
        pos: vec3.clone(secondToLast.pos),
        rot: quat.clone(secondToLast.rot),
      };
      const snapped = snapToPath(bowKeelPath, last.pos[1], 1, _temp4);
      last.pos[0] = snapped[0] + 1;
      last.pos[2] = snapped[2];
      nodes.push(last);
    }

    // extend boards backward for the transom
    if (i < transomPlankNum) {
      const second = nodes[0];
      const third = nodes[1];
      const first: PathNode = {
        pos: vec3.clone(second.pos),
        rot: quat.clone(second.rot),
      };
      const diff = vec3.sub(second.pos, third.pos, first.pos);
      const scale = (transomPlankNum - 1 - i) / (transomPlankNum - 1) + 0.4;
      console.log("scale: " + scale);
      vec3.scale(diff, scale, diff);
      vec3.add(second.pos, diff, first.pos);
      nodes.unshift(first);
    }
    plankPaths.push(nodes);

    let mirroredPath = mirrorPath(clonePath(nodes), [0, 0, 1]);
    plankPathsMirrored.push(mirroredPath);

    appendBoard(builder.mesh, {
      path: nodes,
      width: plankWidth,
      depth: plankDepth,
    });
    appendBoard(builder.mesh, {
      path: mirroredPath,
      width: plankWidth,
      depth: plankDepth,
    });
  }

  // TRANSOM
  for (let i = 0; i < transomPlankNum; i++) {
    const start = plankPaths[i][0];
    const end = plankPathsMirrored[i][0];
    const length = vec3.dist(start.pos, end.pos);
    const numDesired = Math.ceil(length / ribSpace);
    let path: Path = [];

    path.push(start);
    for (let j = 1; j < numDesired - 1; j++) {
      const pos = vec3.lerp(
        start.pos,
        end.pos,
        j / (numDesired - 1),
        vec3.create()
      );
      path.push({
        pos,
        rot: quat.clone(start.rot),
      });
    }
    path.push(end);

    if (i == 2) dbgPathWithGizmos(path);
    for (let n of path) {
      quat.fromEuler(-Math.PI / 2, 0, Math.PI / 2, n.rot);
      quat.rotateY(n.rot, -Math.PI / 16, n.rot);
    }
    appendBoard(builder.mesh, {
      path: path,
      width: plankWidth,
      depth: plankDepth,
    });
  }

  if (false) {
    const __t1 = vec3.create();
    const __t2 = vec3.create();
    for (let i = 0; i < plankCount; i++) {
      const plankPath = clonePath(railPath);
      const plankYOff = -plankWidth * 2.1 * i;
      translatePath(plankPath, [0, plankYOff, 0]);
      for (let i = 0; i < railNodes; i++) {
        const node = plankPath[i];
        // if (i === railNodes - 1) {
        //   node.pos[2] = 0;
        // } else
        if (i === 0) {
          // TODO(@darzu): FIX TRANSOM AREA!!
          const ribPath = ribPaths[0];
          const snapped = snapToPath(ribPath, node.pos[1], 1, __t1);
          node.pos[2] = snapped[2];
        } else {
          // sternKeelPath
          const ribIdx = Math.min(i - 1, ribPaths.length - 1);
          const ribPath = ribPaths[ribIdx];
          // const y = node.pos[1];
          const onRib = snapToPath(ribPath, node.pos[1], 1, __t1);
          const onBow = snapToPath(bowKeelPath, node.pos[1], 1, __t2);
          node.pos[0] = onRib[0];
          node.pos[2] = onRib[2];
          if (i === railNodes - 1 || onRib[1] - 0.1 > node.pos[1]) {
            // node.pos[0] = Math.max(onRib[0], onBow[0]);
            if (i > railNodes / 2) {
              node.pos[0] = onBow[0];
              node.pos[2] = 0;
              // trim the rest of the plank
              for (let j = 0; j < railNodes - 1 - i; j++) {
                plankPath.pop();
              }
              break;
            }
          }
          // node.pos[1] = y;
          // plankPath[i].pos[2] = 0; // TODO(@darzu):
        }
      }
      appendBoard(builder.mesh, {
        path: plankPath,
        width: plankWidth,
        depth: plankDepth,
      });
    }
  }

  // FLOOR
  const floorPlankCount = 7;
  const floorSpace = 1.24;
  const floorLength = ribSpace * (ribCount - 1) + ribWidth * 2.0;
  const floorSegCount = 12;
  const floorHeight = 3.2;
  const floorWidth = floorPlankCount * floorSpace;
  if (false) {
    builder.width = 0.6;
    builder.depth = 0.2;
    for (let i = 0; i < floorPlankCount; i++) {
      mat4.identity(builder.cursor);
      mat4.translate(
        builder.cursor,
        [
          -ribWidth,
          floorHeight - builder.depth,
          (i - (floorPlankCount - 1) * 0.5) * floorSpace + jitter(0.01),
        ],
        builder.cursor
      );
      appendTimberFloorPlank(builder, floorLength, floorSegCount);
    }
  }

  // CEILING
  const ceilPlankCount = 8;
  const ceilSpace = 1.24;
  const ceilLength = ribSpace * (ribCount - 1) + ribWidth * 2.0;
  const ceilSegCount = 12;
  const ceilHeight = 12;
  if (false) {
    for (let i = 0; i < ceilPlankCount; i++) {
      mat4.identity(builder.cursor);
      mat4.translate(
        builder.cursor,
        [
          -ribWidth,
          ceilHeight,
          (i - (ceilPlankCount - 1) * 0.5) * ceilSpace + jitter(0.01),
        ],
        builder.cursor
      );
      builder.width = 0.6;
      builder.depth = 0.2;
      appendTimberFloorPlank(builder, ceilLength, ceilSegCount);
    }
  }

  // WALLS
  // TODO(@darzu): keep in sync with rib path
  const wallLength = floorLength;
  const wallSegCount = 8;
  // for (let i = 0; i < 6; i++) {
  // mat4.identity(builder.cursor);
  // mat4.translate(builder.cursor, builder.cursor, [0, 1, 0]);
  builder.width = 0.45;
  builder.depth = 0.2;
  if (false)
    for (let ccwi = 0; ccwi < 2; ccwi++) {
      const ccw = ccwi === 0;
      const ccwf = ccw ? -1 : 1;
      let xFactor = 0.05;

      const wallOffset: vec3 = V(-ribWidth, 0, ribDepth * -ccwf);

      const cursor2 = mat4.create();
      mat4.rotateX(cursor2, Math.PI * 0.4 * -ccwf, cursor2);

      // mat4.copy(builder.cursor, cursor2);
      // mat4.translate(builder.cursor, builder.cursor, wallOffset);
      // appendTimberWallPlank(builder, wallLength, wallSegCount);

      mat4.copy(builder.cursor, cursor2);
      mat4.translate(builder.cursor, [0, 1, 0], builder.cursor);
      // mat4.rotateX(builder.cursor, builder.cursor, Math.PI * xFactor * ccwf);
      // mat4.rotateX(builder.cursor, builder.cursor, Math.PI * xFactor * ccwf);
      mat4.translate(builder.cursor, wallOffset, builder.cursor);
      appendTimberWallPlank(builder, wallLength, wallSegCount, -1);

      for (let i = 0; i < numRibSegs; i++) {
        mat4.translate(cursor2, [0, 2, 0], cursor2);
        mat4.rotateX(cursor2, Math.PI * xFactor * ccwf, cursor2);

        // plank 1
        mat4.copy(builder.cursor, cursor2);
        mat4.translate(builder.cursor, wallOffset, builder.cursor);
        appendTimberWallPlank(builder, wallLength, wallSegCount, i);

        // plank 2
        mat4.copy(builder.cursor, cursor2);
        mat4.translate(builder.cursor, [0, 1, 0], builder.cursor);
        mat4.rotateX(
          builder.cursor,
          Math.PI * xFactor * 1.0 * ccwf,
          builder.cursor
        );
        mat4.translate(builder.cursor, wallOffset, builder.cursor);
        appendTimberWallPlank(builder, wallLength, wallSegCount, i + 0.5);

        mat4.rotateX(cursor2, Math.PI * xFactor * ccwf, cursor2);
        xFactor = xFactor - 0.005;
      }
      mat4.translate(cursor2, [0, 2, 0], cursor2);
    }
  // }

  // FRONT AND BACK WALL
  let _floorWidth = floorWidth;
  if (false) {
    let wallSegCount = 6;
    let numRibSegs = 6;
    let floorWidth = _floorWidth + 4;
    for (let ccwi = 0; ccwi < 2; ccwi++) {
      const ccw = ccwi === 0;
      const ccwf = ccw ? -1 : 1;
      let xFactor = 0.05;

      const wallOffset: vec3 = V(-ribWidth, 0, ribDepth * -ccwf);

      const cursor2 = mat4.create();
      // mat4.rotateX(cursor2, cursor2, Math.PI * 0.4 * -ccwf);
      // mat4.rotateX(cursor2, cursor2, Math.PI * 0.4 * -ccwf);
      mat4.rotateY(cursor2, Math.PI * 0.5, cursor2);
      if (ccw) {
        mat4.translate(cursor2, [0, 0, floorLength - ribWidth * 2.0], cursor2);
      }
      mat4.translate(cursor2, [-6, 0, 0], cursor2);

      mat4.copy(builder.cursor, cursor2);
      mat4.translate(builder.cursor, [0, 1, 0], builder.cursor);
      // mat4.rotateX(builder.cursor, builder.cursor, Math.PI * xFactor * ccwf);
      // mat4.rotateX(builder.cursor, builder.cursor, Math.PI * xFactor * ccwf);
      mat4.translate(builder.cursor, wallOffset, builder.cursor);
      appendTimberWallPlank(builder, floorWidth, wallSegCount, -1);

      for (let i = 0; i < numRibSegs; i++) {
        mat4.translate(cursor2, [0, 2, 0], cursor2);
        // mat4.rotateX(cursor2, cursor2, Math.PI * xFactor * ccwf);

        // plank 1
        mat4.copy(builder.cursor, cursor2);
        mat4.translate(builder.cursor, wallOffset, builder.cursor);
        appendTimberWallPlank(builder, floorWidth, wallSegCount, i);

        // plank 2
        mat4.copy(builder.cursor, cursor2);
        mat4.translate(builder.cursor, [0, 1, 0], builder.cursor);
        // mat4.rotateX(
        //   builder.cursor,
        //   builder.cursor,
        //   Math.PI * xFactor * 1.0 * ccwf
        // );
        // mat4.rotateX(
        //   builder.cursor,
        //   builder.cursor,
        //   Math.PI * xFactor * 1.0 * ccwf
        // );
        mat4.translate(builder.cursor, wallOffset, builder.cursor);
        appendTimberWallPlank(builder, floorWidth, wallSegCount, i + 0.5);

        // mat4.rotateX(cursor2, cursor2, Math.PI * xFactor * ccwf);
        // xFactor = xFactor - 0.005;
      }
      mat4.translate(cursor2, [0, 2, 0], cursor2);
    }
  }

  // console.dir(_timberMesh.colors);
  _timberMesh.surfaceIds = _timberMesh.colors.map((_, i) => i);
  const timberState = getBoardsFromMesh(_timberMesh);
  verifyUnsharedProvokingForWood(_timberMesh, timberState);
  // unshareProvokingForWood(_timberMesh, timberState);
  // console.log(`before: ` + meshStats(_timberMesh));
  // const timberMesh = normalizeMesh(_timberMesh);
  // console.log(`after: ` + meshStats(timberMesh));
  const timberMesh = _timberMesh as Mesh;
  timberMesh.usesProvoking = true;

  reserveSplinterSpace(timberState, 200);
  validateMesh(timberState.mesh);

  const _end = performance.now();
  console.log(`createHomeShip took: ${(_end - _start).toFixed(1)}ms`);

  return {
    timberState,
    timberMesh,
    ribCount,
    ribSpace,
    ribWidth,
    ceilHeight,
    floorHeight,
    floorLength,
    floorWidth,
  };
}

export function appendTimberWallPlank(
  b: TimberBuilder,
  length: number,
  numSegs: number,
  plankIdx: number
) {
  const firstQuadIdx = b.mesh.quad.length;

  // mat4.rotateY(b.cursor, b.cursor, Math.PI * 0.5);
  // mat4.rotateX(b.cursor, b.cursor, Math.PI * 0.5);
  // mat4.rotateY(b.cursor, b.cursor, Math.PI * 0.5);
  // mat4.rotateX(b.cursor, b.cursor, Math.PI * 0.5);
  mat4.rotateZ(b.cursor, Math.PI * 1.5, b.cursor);

  b.addLoopVerts();
  b.addEndQuad(true);

  const segLen = length / numSegs;

  for (let i = 0; i < numSegs; i++) {
    if (i === 2 && 3 <= plankIdx && plankIdx <= 4) {
      // hole
      b.addEndQuad(false);
      mat4.translate(b.cursor, [0, segLen * 0.55, 0], b.cursor);
      b.addLoopVerts();
      b.addEndQuad(true);
      mat4.translate(b.cursor, [0, segLen * 0.45, 0], b.cursor);
    } else {
      // normal
      mat4.translate(b.cursor, [0, segLen, 0], b.cursor);
      b.addLoopVerts();
      b.addSideQuads();
    }
  }

  b.addEndQuad(false);

  for (let qi = firstQuadIdx; qi < b.mesh.quad.length; qi++) {
    const clr = randNormalPosVec3(vec3.create());
    // const clr = vec3.clone(BLACK);
    // const clr = vec3.clone(vec3.ONES);
    // vec3.scale(clr, clr, jitter(0.5));
    vec3.scale(clr, 0.5, clr);
    b.mesh.colors.push(clr);
  }

  // console.dir(b.mesh);

  return b.mesh;
}

export function appendTimberFloorPlank(
  b: TimberBuilder,
  length: number,
  numSegs: number
) {
  const firstQuadIdx = b.mesh.quad.length;

  mat4.rotateY(b.cursor, Math.PI * 0.5, b.cursor);
  mat4.rotateX(b.cursor, Math.PI * 0.5, b.cursor);

  b.addLoopVerts();
  b.addEndQuad(true);

  const segLen = length / numSegs;

  for (let i = 0; i < numSegs; i++) {
    mat4.translate(b.cursor, [0, segLen, 0], b.cursor);
    b.addLoopVerts();
    b.addSideQuads();
  }

  b.addEndQuad(false);

  for (let qi = firstQuadIdx; qi < b.mesh.quad.length; qi++)
    b.mesh.colors.push(vec3.clone(BLACK));

  // console.dir(b.mesh);

  return b.mesh;
}

interface Board {
  path: Path;

  width: number;
  depth: number;
}

interface PathNode {
  // TODO(@darzu): different path formats? e.g. bezier, mat4s, relative pos/rot,
  pos: vec3;
  rot: quat;
}
type Path = PathNode[];

function nodeFromMat4(cursor: mat4): PathNode {
  const rot = mat4.getRotation(cursor, quat.create());
  const pos = vec3.transformMat4(vec3.ZEROS, cursor, vec3.create());
  return {
    pos,
    rot,
  };
}

function clonePath(path: Path): Path {
  return path.map((old) => ({
    rot: quat.clone(old.rot),
    pos: vec3.clone(old.pos),
  }));
}

function cloneBoard(board: Board): Board {
  return {
    ...board,
    path: clonePath(board.path),
  };
}
function translatePath(p: Path, tran: vec3.InputT) {
  p.forEach((n) => vec3.add(n.pos, tran, n.pos));
  return p;
}
const __temp3 = vec3.create();
function translatePathAlongNormal(p: Path, t: number) {
  p.forEach((n) => {
    const norm = vec3.transformQuat([0, 0, 1], n.rot, __temp3);
    vec3.scale(norm, t, norm);
    vec3.add(n.pos, norm, n.pos);
  });
  return p;
}
let __mirrorMat = mat3.create();
let __tq1 = quat.create();
function mirrorPath(p: Path, planeNorm: vec3.InputT) {
  // TODO(@darzu): support non-origin planes
  if (DBG_ASSERT)
    assert(
      Math.abs(vec3.sqrLen(planeNorm) - 1.0) < 0.01,
      `mirror plane must be normalized`
    );
  let a = planeNorm[0];
  let b = planeNorm[1];
  let c = planeNorm[2];

  // https://math.stackexchange.com/a/696190/126904
  let mirrorMat3 = mat3.set(
    1 - 2 * a ** 2,
    -2 * a * b,
    -2 * a * c,
    -2 * a * b,
    1 - 2 * b ** 2,
    -2 * b * c,
    -2 * a * c,
    -2 * b * c,
    1 - 2 * c ** 2,
    __mirrorMat
  );

  // TODO(@darzu): can we use the mat3 instead of mirror quat?
  // https://stackoverflow.com/a/49234603/814454
  let mirrorQuat = quat.set(a, b, c, 0, __tq1);

  p.forEach((curr) => {
    quat.mul(mirrorQuat, curr.rot, curr.rot);
    quat.mul(curr.rot, mirrorQuat, curr.rot);
    vec3.transformMat3(curr.pos, mirrorMat3, curr.pos);
  });

  return p;
}

interface BezierCubic {
  p0: vec3;
  p1: vec3;
  p2: vec3;
  p3: vec3;
}
function reverseBezier(b: BezierCubic): BezierCubic {
  return {
    p0: vec3.clone(b.p3),
    p1: vec3.clone(b.p2),
    p2: vec3.clone(b.p1),
    p3: vec3.clone(b.p0),
  };
}
function bezierPosition(b: BezierCubic, t: number, out: vec3): vec3 {
  // https://en.wikipedia.org/wiki/Bézier_curve
  // B =
  //   (1 - t) ** 3 * p0
  // + 3 * (1 - t) ** 2 * t * p1
  // + 3 * (1 - t) * t ** 2 * p2
  // + t ** 3 * p3
  const t0 = (1 - t) ** 3;
  const t1 = 3 * (1 - t) ** 2 * t;
  const t2 = 3 * (1 - t) * t ** 2;
  const t3 = t ** 3;
  out[0] = b.p0[0] * t0 + b.p1[0] * t1 + b.p2[0] * t2 + b.p3[0] * t3;
  out[1] = b.p0[1] * t0 + b.p1[1] * t1 + b.p2[1] * t2 + b.p3[1] * t3;
  out[2] = b.p0[2] * t0 + b.p1[2] * t1 + b.p2[2] * t2 + b.p3[2] * t3;
  return out;
}
function bezierTangent(b: BezierCubic, t: number, out: vec3): vec3 {
  const t0 = 3 * (1 - t) ** 2;
  const t1 = 6 * (1 - t) * t;
  const t2 = 3 * t ** 2;
  out[0] =
    t0 * (b.p1[0] - b.p0[0]) +
    t1 * (b.p2[0] - b.p1[0]) +
    t2 * (b.p3[0] - b.p2[0]);
  out[1] =
    t0 * (b.p1[1] - b.p0[1]) +
    t1 * (b.p2[1] - b.p1[1]) +
    t2 * (b.p3[1] - b.p2[1]);
  out[2] =
    t0 * (b.p1[2] - b.p0[2]) +
    t1 * (b.p2[2] - b.p1[2]) +
    t2 * (b.p3[2] - b.p2[2]);
  return out;
}
function createPathFromBezier(
  b: BezierCubic,
  nodeCount: number,
  up: vec3.InputT
): Path {
  assert(nodeCount >= 2);
  const path: Path = [];
  for (let i = 0; i < nodeCount; i++) {
    const t = i / (nodeCount - 1);
    const pos = bezierPosition(b, t, vec3.create());
    const tan = bezierTangent(b, t, vec3.tmp());
    vec3.normalize(tan, tan);
    const rot = quatFromUpForward(quat.create(), up, tan);
    path.push({ pos, rot });
  }
  return path;
}
const _numSamples = 100;
const __tempSamples = range(_numSamples).map((i) => vec3.create());
function createEvenPathFromBezier(
  b: BezierCubic,
  spacing: number,
  up: vec3.InputT
): Path {
  const path: Path = [];
  const samples = range(_numSamples).map((i) =>
    bezierPosition(b, i / (_numSamples - 1), __tempSamples[i])
  );
  const distances: number[] = [];
  let prevPos = samples[0];
  let lastDist = 0;
  for (let i = 0; i < samples.length; i++) {
    const newTravel = vec3.dist(samples[i], prevPos);
    const dist = lastDist + newTravel;
    prevPos = samples[i];
    lastDist = dist;
    distances.push(dist);
  }
  // console.log("distances");
  // console.dir(distances);
  let totalDistance = distances[distances.length - 1];
  // TODO(@darzu): instead of floor, maybe ceil
  // let numSeg = Math.floor(totalDistance / spacing);
  let numSeg = Math.ceil(totalDistance / spacing);
  let prevJ = 0;
  for (let i = 0; i < numSeg; i++) {
    const toTravel = i * spacing;
    let prevDist = 0;
    let prevPrevDist = 0;
    let didAdd = false;
    for (let j = prevJ; j < samples.length; j++) {
      const nextDist = distances[j];
      if (nextDist > toTravel) {
        // find our spot
        const span = nextDist - prevDist;
        const extra = nextDist - toTravel;
        const prevT = Math.max((j - 1) / (_numSamples - 1), 0);
        const currT = j / (_numSamples - 1);
        const bonusRatio = 1 - extra / span;
        const t = prevT + bonusRatio * (currT - prevT);
        prevJ = j;

        // add our node
        const pos = bezierPosition(b, t, vec3.create());
        const tan = bezierTangent(b, t, vec3.tmp());
        vec3.normalize(tan, tan);
        const rot = quatFromUpForward(quat.create(), up, tan);
        path.push({ pos, rot });
        didAdd = true;
        // console.log(`adding: ${t} -> ${vec3Dbg(pos)}`);
        break;
      }
      prevPrevDist = prevDist;
      prevDist = nextDist;
    }
    if (!didAdd) {
      const span = prevDist - prevPrevDist;
      const extra = toTravel - prevDist;
      const extraSteps = extra / span;
      const lastSample = samples[samples.length - 1];
      const lastSample2 = samples[samples.length - 2];
      const dir = vec3.sub(lastSample, lastSample2, vec3.create());
      vec3.normalize(dir, dir);
      vec3.scale(dir, extraSteps, dir);
      const pos = vec3.add(lastSample, dir, dir);
      const rot = quat.clone(path[path.length - 1].rot);
      path.push({ pos, rot });
    }
  }
  //  = samples.reduce((p, n, i) =>
  // while (true) {}

  return path;
}

function makeRibPathWierd(idx: number): Path {
  const cursor = mat4.create();

  const ribCount = 10;
  const iF = idx / (ribCount - 1.0);
  const mF = Math.abs(iF - 0.5);
  const eF = 1.0 - mF;

  // TODO(@darzu): TWEAK ALL THIS IN UI!
  let initAngle = -0.45;
  let angle = 0.03 + mF * 0.02;
  let dAngle = 0.005 + eF * 0.01;

  const path: Path = [];

  mat4.rotateX(cursor, Math.PI * initAngle, cursor);
  path.push(nodeFromMat4(cursor));

  for (let i = 0; i < numRibSegs; i++) {
    mat4.translate(cursor, [0, 2, 0], cursor);
    mat4.rotateX(cursor, Math.PI * angle, cursor);
    path.push(nodeFromMat4(cursor));
    mat4.rotateX(cursor, Math.PI * angle, cursor);
    angle = angle - dAngle;
  }
  mat4.translate(cursor, [0, 2, 0], cursor);
  path.push(nodeFromMat4(cursor));

  return path;
}

// TODO(@darzu): BEZIER STUFF!

// function makeRibPath(height: number, width: number): Path {
//   const cursor = mat4.create();

//   const ribCount = 10;
//   const iF = idx / (ribCount - 1.0);
//   const mF = Math.abs(iF - 0.5);
//   const eF = 1.0 - mF;

//   // TODO(@darzu): TWEAK ALL THIS IN UI!
//   let initAngle = -0.45;
//   let angle = 0.03 + mF * 0.02;
//   let dAngle = 0.005 + eF * 0.01;

//   const path: Path = [];

//   mat4.rotateX(cursor, Math.PI * initAngle, cursor);
//   path.push(nodeFromMat4(cursor));

//   for (let i = 0; i < numRibSegs; i++) {
//     mat4.translate(cursor, [0, 2, 0], cursor);
//     mat4.rotateX(cursor, Math.PI * angle, cursor);
//     path.push(nodeFromMat4(cursor));
//     mat4.rotateX(cursor, Math.PI * angle, cursor);
//     angle = angle - dAngle;
//   }
//   mat4.translate(cursor, [0, 2, 0], cursor);
//   path.push(nodeFromMat4(cursor));

//   return path;
// }

function appendBoard(mesh: RawMesh, board: Board) {
  assert(board.path.length >= 2, `invalid board path!`);
  // TODO(@darzu): de-duplicate with TimberBuilder
  const firstQuadIdx = mesh.quad.length;
  // const mesh = b.mesh;

  board.path.forEach((p, i) => {
    addLoopVerts(p);
    if (i === 0) addEndQuad(true);
    else addSideQuads();
  });
  addEndQuad(false);

  // TODO(@darzu): streamline
  for (let qi = firstQuadIdx; qi < mesh.quad.length; qi++)
    mesh.colors.push(vec3.clone(BLACK));

  // NOTE: for provoking vertices,
  //  indexes 0, 1 of a loop are for stuff behind (end cap, previous sides)
  //  indexes 2, 3 of a loop are for stuff ahead (next sides, end cap)

  function addSideQuads() {
    const loop2Idx = mesh.pos.length - 4;
    const loop1Idx = mesh.pos.length - 4 - 4;

    const q0 = vec4.create();
    const q1 = vec4.create();
    const q2 = vec4.create();
    const q3 = vec4.create();

    setSideQuadIdxs(loop1Idx, loop2Idx, q0, q1, q2, q3);

    mesh.quad.push(q0, q1, q2, q3);
  }

  function addEndQuad(facingDown: boolean) {
    const lastLoopIdx = mesh.pos.length - 4;
    const q = vec4.create();
    setEndQuadIdxs(lastLoopIdx, q, facingDown);
    mesh.quad.push(q);
  }

  function addLoopVerts(n: PathNode) {
    // width/depth
    const v0 = V(board.width, 0, board.depth);
    const v1 = V(board.width, 0, -board.depth);
    const v2 = V(-board.width, 0, -board.depth);
    const v3 = V(-board.width, 0, board.depth);
    // rotate
    vec3.transformQuat(v0, n.rot, v0);
    vec3.transformQuat(v1, n.rot, v1);
    vec3.transformQuat(v2, n.rot, v2);
    vec3.transformQuat(v3, n.rot, v3);
    // translate
    vec3.add(v0, n.pos, v0);
    vec3.add(v1, n.pos, v1);
    vec3.add(v2, n.pos, v2);
    vec3.add(v3, n.pos, v3);
    // append
    mesh.pos.push(v0, v1, v2, v3);
  }
}

export function appendTimberRib(b: TimberBuilder, ccw: boolean) {
  const firstQuadIdx = b.mesh.quad.length;

  const ccwf = ccw ? -1 : 1;

  mat4.rotateX(b.cursor, Math.PI * 0.4 * -ccwf, b.cursor);

  b.addLoopVerts();
  b.addEndQuad(true);
  let xFactor = 0.05;
  for (let i = 0; i < numRibSegs; i++) {
    mat4.translate(b.cursor, [0, 2, 0], b.cursor);
    mat4.rotateX(b.cursor, Math.PI * xFactor * ccwf, b.cursor);
    b.addLoopVerts();
    b.addSideQuads();
    mat4.rotateX(b.cursor, Math.PI * xFactor * ccwf, b.cursor);
    // mat4.rotateY(b.cursor, b.cursor, Math.PI * -0.003);
    xFactor = xFactor - 0.005;
  }
  mat4.translate(b.cursor, [0, 2, 0], b.cursor);
  b.addLoopVerts();
  b.addSideQuads();
  b.addEndQuad(false);

  for (let qi = firstQuadIdx; qi < b.mesh.quad.length; qi++)
    b.mesh.colors.push(vec3.clone(BLACK));

  // console.dir(b.mesh);

  return b.mesh;
}
