// TODO(@darzu): box vs box collision testing
// https://www.youtube.com/watch?v=ajv46BSqcK4
// https://www.youtube.com/watch?v=MDusDn8oTSE

import { EntityManager, EntityW } from "../entity-manager.js";
import { AssetsDef } from "../game/assets.js";
import { ColorDef } from "../color.js";
import { LocalPlayerDef } from "../game/player.js";
import { vec3 } from "../gl-matrix.js";
import { cloneMesh } from "../render/mesh-pool.js";
import { RenderableConstructDef } from "../render/renderer.js";
import { BoxCollider, Collider } from "./collider.js";
import { PhysicsObject, WorldFrameDef } from "./nonintersection.js";
import { PhysicsParentDef, PositionDef } from "./transform.js";
import { centroid, vec3Dbg } from "../utils-3d.js";

// TODO(@darzu): interfaces worth thinking about:
// export interface ContactData {
//     aId: number;
//     bId: number;
//     bToANorm: vec3;
//     dist: number;
//   }
// export interface ReboundData {
//     aId: number;
//     bId: number;
//     aRebound: number;
//     bRebound: number;
//     aOverlap: vec3;
//     bOverlap: vec3;
//   }
// function computeReboundData(
//     a: PhysicsObject,
//     b: PhysicsObject,
//     itr: number
//   ): ReboundData {

/*
Box-based non-intersection
or
common-parent rotated AABBs non-intersection

leaning towards box-based as it's easier on the game dev.
needs seperate: rotation and translation non-intersection phases.
  likely we'll need pill colliders for players so they can rotate in a corner
*/

export function registerNarrowPhaseSystems(em: EntityManager) {
  // TODO(@darzu):
}

export type SupportFn = (d: vec3) => vec3;

export function boxLocalPoints(m: vec3, s: vec3): vec3[] {
  return [
    vec3.fromValues(m[0] - s[0], m[1] - s[1], m[2] - s[2]),
    vec3.fromValues(m[0] - s[0], m[1] - s[1], m[2] + s[2]),
    vec3.fromValues(m[0] - s[0], m[1] + s[1], m[2] - s[2]),
    vec3.fromValues(m[0] - s[0], m[1] + s[1], m[2] + s[2]),
    vec3.fromValues(m[0] + s[0], m[1] - s[1], m[2] - s[2]),
    vec3.fromValues(m[0] + s[0], m[1] - s[1], m[2] + s[2]),
    vec3.fromValues(m[0] + s[0], m[1] + s[1], m[2] - s[2]),
    vec3.fromValues(m[0] + s[0], m[1] + s[1], m[2] + s[2]),
  ];
}

export function farthestPointInDir(points: vec3[], d: vec3): vec3 {
  let max = -Infinity;
  let maxP: vec3 | null = null;
  for (let p of points) {
    const n = vec3.dot(p, d);
    if (n > max) {
      max = n;
      maxP = p;
    }
  }
  return maxP!;
}

type Shape = {
  center: vec3;
  support: SupportFn;
};

// minkowski difference support
function mSupport(s1: Shape, s2: Shape, d: vec3): vec3 {
  // TODO(@darzu):
  const nD = vec3.negate(vec3.create(), d);
  return vec3.sub(vec3.create(), s2.support(d), s1.support(nD));
}

// GJK visualization

export function doesSimplexOverlapOrigin(s: vec3[]) {
  if (s.length !== 4) return false;

  const tris = [
    [s[0], s[1], s[2]],
    [s[0], s[1], s[3]],
    [s[0], s[2], s[3]],
    [s[1], s[2], s[3]],
  ];

  const center = centroid(s);

  for (let t of tris) {
    const [C, B, A] = t;
    const AB = vec3.sub(vec3.create(), B, A);
    const AC = vec3.sub(vec3.create(), C, A);
    const ABCperp = vec3.cross(vec3.create(), AB, AC);
    vec3.normalize(ABCperp, ABCperp);
    const triCenter = centroid(t);
    const triCenterToSimplexCenter = vec3.sub(vec3.create(), center, triCenter);
    vec3.normalize(triCenterToSimplexCenter, triCenterToSimplexCenter);
    if (vec3.dot(ABCperp, triCenterToSimplexCenter) < 0)
      vec3.negate(ABCperp, ABCperp);
    const AO = vec3.sub(vec3.create(), [0, 0, 0], A);
    if (vec3.dot(ABCperp, AO) < 0) return false;
  }
  return true;
}

let d: vec3 = vec3.create();
let simplex: vec3[] = [];
let distToOrigin = Infinity;
export function gjk(s1: Shape, s2: Shape): boolean {
  vec3.sub(d, s2.center, s1.center);
  vec3.normalize(d, d);
  simplex = [mSupport(s1, s2, d)];
  vec3.sub(d, [0, 0, 0], simplex[0]);
  vec3.normalize(d, d);
  let step = 0;
  while (true) {
    const A = mSupport(s1, s2, d);
    if (vec3.dot(A, d) < 0) {
      console.log(`false on step: ${step}`);
      console.log(`A: ${vec3Dbg(A)}, d: ${vec3Dbg(d)}`);
      console.dir(simplex);
      return false;
    }
    step++;
    if (step > 100) {
      console.warn(`u oh, running too long`);
      return false;
    }
    // console.log(`adding: ${A}`);
    simplex.push(A);
    const newDist = vec3.len(centroid(simplex));
    // if (newDist > distToOrigin) {
    //   console.warn(`moving away from origin!`);
    // }
    distToOrigin = newDist;
    const intersects = handleSimplex(s1, s2);
    if (intersects) {
      if (!doesSimplexOverlapOrigin(simplex))
        console.error(`we dont think it actually overlaps origin`);
      // else console.log(`probably overlaps :)`);
      console.log(`true on step: ${step}`);
      return true;
    }
  }
}

function dbgIsDirGood(s1: Shape, s2: Shape, d: vec3) {
  const A = mSupport(s1, s2, d);
  if (vec3.dot(A, d) < 0) {
    return true;
  }
  const simp = [...simplex, A];
  const newDist = vec3.len(centroid(simp));
  if (newDist > distToOrigin) {
    console.warn(`moving away from origin!`);
    return false;
  }
  return true;
}

function tripleProd(out: vec3, a: vec3, b: vec3, c: vec3): vec3 {
  vec3.cross(out, a, b);
  vec3.cross(out, out, c);
  return out;
}
function handleSimplex(s1: Shape, s2: Shape): boolean {
  if (simplex.length === 2) {
    // line case
    const [B, A] = simplex;
    const AB = vec3.sub(vec3.create(), B, A);
    const AO = vec3.sub(vec3.create(), [0, 0, 0], A);
    const ABperp = tripleProd(vec3.create(), AB, AO, AB);
    vec3.copy(d, ABperp);
    return false;
  } else if (simplex.length === 3) {
    // triangle case
    const [C, B, A] = simplex;
    const AB = vec3.sub(vec3.create(), B, A);
    const AC = vec3.sub(vec3.create(), C, A);
    const ABCperp = vec3.cross(vec3.create(), AB, AC);
    const AO = vec3.sub(vec3.create(), [0, 0, 0], A);
    if (vec3.dot(ABCperp, AO) < 0) vec3.negate(ABCperp, ABCperp);
    vec3.copy(d, ABCperp);
    if (!dbgIsDirGood(s1, s2, d)) console.warn(`bad dir from tri case`);
    return false;
  } else {
    // tetrahedron
    const [D, C, B, A] = simplex;
    // TODO(@darzu):
    const AB = vec3.sub(vec3.create(), B, A);
    const AC = vec3.sub(vec3.create(), C, A);
    const AD = vec3.sub(vec3.create(), D, A);
    const AO = vec3.sub(vec3.create(), [0, 0, 0], A);

    const ABCperp = vec3.cross(vec3.create(), AB, AC);
    if (vec3.dot(ABCperp, AD) > 0) {
      console.log(`neg ABCperp`);
      vec3.negate(ABCperp, ABCperp);
    }
    const ACDperp = vec3.cross(vec3.create(), AC, AD);
    if (vec3.dot(ACDperp, AB) > 0) {
      console.log(`neg ACDperp`);
      vec3.negate(ACDperp, ACDperp);
    }
    const ADBperp = vec3.cross(vec3.create(), AD, AB);
    if (vec3.dot(ADBperp, AC) > 0) {
      console.log(`neg ADBperp`);
      vec3.negate(ADBperp, ADBperp);
    }

    if (vec3.dot(ABCperp, AO) > 0) {
      if (!dbgIsDirGood(s1, s2, d)) console.warn(`bad dir from ABCperp`);
      simplex = [C, B, A];
      vec3.copy(d, ABCperp);
      return false;
    }
    if (vec3.dot(ACDperp, AO) > 0) {
      if (!dbgIsDirGood(s1, s2, d)) console.warn(`bad dir from ACDperp`);
      simplex = [D, C, A];
      vec3.copy(d, ACDperp);
      return false;
    }
    if (vec3.dot(ADBperp, AO) > 0) {
      if (!dbgIsDirGood(s1, s2, d)) console.warn(`bad dir from ADBperp`);
      simplex = [D, B, A];
      vec3.copy(d, ADBperp);
      return false;
    }
    return true;
  }
}
