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
import { assert, assertDbg } from "../util.js";
import { centroid, quatFromUpForward, randNormalPosVec3 } from "../utils-3d.js";
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
  for (let i = 0; i < path.length; i++) {
    let pos = path[i].pos;
    // are we ahead of x
    if (x < pos[0]) {
      if (i === 0) {
        // x is before the whole path
        vec3.copy(out, path[i].pos);
        return out;
      }
      let prev = path[i - 1].pos;
      assert(prev[0] <= x, `TODO: we assume path is in assending X order`);

      let diff = vec3.sub(pos, prev);
      let percent = (x - prev[0]) / diff[0];
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
  const ribCount = 10;
  // const ribSpace = 3;

  const keelLength = keelSize[0];
  const ribSpace = keelLength / (ribCount + 1);

  let railCurve: BezierCubic;
  {
    const railHeight = keelAABB.max[1] - 1;
    const prowOverhang = 0.5;
    const prow = V(keelAABB.max[0] + prowOverhang, railHeight, 0);
    const sternOverhang = 2;
    const sternpost = V(keelAABB.min[0] - sternOverhang, railHeight, 0);
    const transomWidth = 12;
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
  const railPath = createPathFromBezier(railCurve, 16, [0, 1, 0]);
  fixPathBasis(railPath, [0, 1, 0], [0, 0, 1], [1, 0, 0]);
  dbgPathWithGizmos(railPath);
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

  for (let i = 0; i < ribCount; i++) {
    const ribX = i * ribSpace + ribSpace + keelAABB.min[0];
    const ribStart = snapXToPath(keelPath, ribX, vec3.create());
    // const p = translatePath(makeRibPath(i), V(i * ribSpace, 0, 0));
    const p = translatePath(makeRibPathWierd(i), ribStart);
    // if (i === 0) dbgPathWithGizmos(p);

    // TODO(@darzu): compute outboard with bezier curve
    const outboard = (1 - Math.abs(i - ribCount / 2) / (ribCount / 2)) * 10;

    let ribCurve: BezierCubic;
    {
      const p0 = vec3.clone(ribStart);
      const p1 = vec3.add(p0, [0, 0, 5], vec3.create());
      const p3 = vec3.add(ribStart, [0, keelSize[1], outboard], vec3.create());
      const p2 = vec3.add(p3, [0, -5, 0], vec3.create());
      ribCurve = { p0, p1, p2, p3 };
    }

    const numRibSegs = 8;
    const bPath = createPathFromBezier(ribCurve, numRibSegs, [1, 0, 0]);

    if (i === 0) {
      console.log("RIB BEZIER PATH");
      console.log(outboard);
      console.dir(ribCurve);
      console.dir(bPath);
      dbgPathWithGizmos(bPath);
    }

    appendBoard(builder.mesh, {
      path: p,
      width: ribWidth,
      depth: ribDepth,
    });

    appendBoard(builder.mesh, {
      path: mirrorPath(clonePath(p), V(0, 0, 1)),
      width: ribWidth,
      depth: ribDepth,
    });
  }

  // FLOOR
  const floorPlankCount = 7;
  const floorSpace = 1.24;
  const floorLength = ribSpace * (ribCount - 1) + ribWidth * 2.0;
  const floorSegCount = 12;
  const floorHeight = 3.2;
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
  const floorWidth = floorPlankCount * floorSpace;
  // CEILING
  const ceilPlankCount = 8;
  const ceilSpace = 1.24;
  const ceilLength = ribSpace * (ribCount - 1) + ribWidth * 2.0;
  const ceilSegCount = 12;
  const ceilHeight = 12;
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
function mirrorPath(p: Path, planeNorm: vec3) {
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
    1 - 2 * c ** 2
  );

  // TODO(@darzu): can we use mat3 instead of mirror quat?
  // https://stackoverflow.com/a/49234603/814454
  let mirrorQuat = quat.set(a, b, c, 0);

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
