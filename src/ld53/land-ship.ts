import { AssetsDef } from "../assets.js";
import { ColorDef } from "../color-ecs.js";
import { ENDESGA16 } from "../color/palettes.js";
import { DeadDef } from "../delete.js";
import { createRef, Ref } from "../em_helpers.js";
import { EM, Entity, EntityW } from "../entity-manager.js";
import { createEntityPool } from "../entity-pool.js";
import { fireBullet } from "../games/bullet.js";
import { PartyDef } from "../games/party.js";
import { jitter } from "../math.js";
import {
  AABB,
  createAABB,
  doesOverlapAABB,
  mergeAABBs,
  pointInAABB,
  updateAABBWithPoint,
} from "../physics/aabb.js";
import { PhysicsStateDef, WorldFrameDef } from "../physics/nonintersection.js";
import {
  PhysicsParentDef,
  PositionDef,
  RotationDef,
} from "../physics/transform.js";
import { TextureReader } from "../render/cpu-texture.js";
import { Mesh } from "../render/mesh.js";
import {
  RenderableConstructDef,
  RenderableDef,
} from "../render/renderer-ecs.js";
import { LevelMapDef } from "../smol/level-map.js";
import { ShipDef } from "../smol/ship.js";
import { mat4, tV, V, vec3, quat, vec2 } from "../sprig-matrix.js";
import { TimeDef } from "../time.js";
import { assert } from "../util.js";
import { vec3Dbg } from "../utils-3d.js";

const SAMPLES_PER_EDGE = 5;
const NUDGE_DIST = 1.0;

export const LandDef = EM.defineComponent(
  "land",
  (sample: (x: number, y: number) => number) => ({
    sample,
  })
);

const zBasis = vec2.create();
const xBasis = vec2.create();
const xBasis3 = vec3.create();
const corner1 = vec2.create();
const corner2 = vec2.create();
const corner3 = vec2.create();
const corner4 = vec2.create();
const pointTemp = vec2.create();
const nudgeTemp = vec3.create();
const scaledTemp1 = vec2.create();
const scaledTemp2 = vec2.create();

EM.registerSystem(
  [ShipDef, PositionDef, WorldFrameDef, PhysicsStateDef],
  [PartyDef, LandDef, LevelMapDef],
  (es, res) => {
    if (!es.length) return;
    const ship = es[0];
    assert(ship._phys.colliders.length >= 1);
    const worldAABB = ship._phys.colliders[0].aabb;
    const selfAABB = ship._phys.colliders[0].selfAABB;

    const shipWidth = selfAABB.max[0] - selfAABB.min[0];
    const halfWidth = shipWidth / 2;
    const shipLength = selfAABB.max[2] - selfAABB.min[2];
    const halfLength = shipLength / 2;
    const shipCenter = V(res.party.pos[0], res.party.pos[2]);

    // res.party.dir is Z
    vec2.set(
      res.party.dir[0] * halfLength,
      res.party.dir[2] * halfLength,
      zBasis
    );
    vec3.cross([0, 1, 0], res.party.dir, xBasis3);
    vec2.set(xBasis3[0] * halfWidth, xBasis3[1] * halfWidth, xBasis);

    // corners of the ship in world-space in clockwise order
    const corners: vec2[] = [
      vec2.sub(vec2.sub(shipCenter, zBasis, corner1), xBasis, corner1),
      vec2.sub(vec2.add(shipCenter, zBasis, corner2), xBasis, corner2),
      vec2.add(vec2.sub(shipCenter, zBasis, corner3), xBasis, corner3),
      vec2.add(vec2.add(shipCenter, zBasis, corner4), xBasis, corner4),
    ];

    function isLand(x: number, z: number) {
      return res.land.sample(x, z) * 100.0 > 1.0;
    }

    let hitLand = false;
    // go through each corner and sample along the edge between it and its neighbor

    for (let i = 0; i < corners.length; i++) {
      const corner = corners[i];
      const neighbor = corners[(i + 1) % 4];
      for (let s = 0; s <= SAMPLES_PER_EDGE; s++) {
        const r = s / SAMPLES_PER_EDGE;
        const point = vec2.add(
          vec2.scale(corner, r, scaledTemp1),
          vec2.scale(neighbor, 1 - r, scaledTemp2),
          pointTemp
        );
        if (isLand(point[0], point[1])) {
          console.log("touching land");
          const dist = vec2.sub(neighbor, corner, pointTemp);
          const nudge = vec3.cross(
            [0, 1, 0],
            vec3.set(dist[0], 0, dist[1], nudgeTemp),
            nudgeTemp
          );
          vec3.normalize(nudge, nudge);
          vec3.scale(nudge, NUDGE_DIST, nudge);
          // TODO: this should be in world space
          vec3.add(ship.position, nudge, ship.position);
          hitLand = true;
          break;
        }
      }
      if (hitLand) break;
    }
    if (hitLand) {
      // TODO: take ship damage
    }

    //    console.log(corners);

    // const winYi =
    //   ((worldAABB.min[0] + res.land.worldHeight * 0.5) / res.land.worldHeight) *
    //   res.land.texReader.size[0];
    // const winXi =
    //   ((worldAABB.min[2] + res.land.worldWidth * 0.5) / res.land.worldWidth) *
    //   res.land.texReader.size[1];
    // // NOTE: width is based on world Z and tex X
    // //       height is based on world X and tex Y
    // const winWi = Math.ceil(worldAABB.max[2] - worldAABB.min[2]);
    // const winHi = Math.ceil(worldAABB.max[0] - worldAABB.min[0]);

    // if (
    //   winXi < 0 ||
    //   res.land.texReader.size[0] <= winXi + winWi ||
    //   winYi < 0 ||
    //   res.land.texReader.size[1] <= winYi + winHi
    // ) {
    //   console.log("off the map");
    //   return;
    // }
    // const shipW = selfAABB.max[2] - selfAABB.min[2];
    // const shipH = selfAABB.max[0] - selfAABB.min[0];

    // for (let xi = winXi; xi < winXi + winWi; xi++) {
    //   for (let yi = winYi; yi < winYi + winHi; yi++) {
    //     const z =
    //       xi * res.land.worldUnitPerTerraVerts - res.land.worldHeight * 0.5;
    //     const x =
    //       yi * res.land.worldUnitPerTerraVerts - res.land.worldWidth * 0.5;

    //     // NOTE: PERF! we inlined all the dot products and cross products here for a
    //     //  perf win.
    //     // TODO(@darzu): make it easier to do this inlining automatically?
    //     // let toParty = vec3.sub(V(x, 0, z), res.party.pos);
    //     // let zDist = vec3.dot(toParty, res.party.dir);
    //     // let partyX = vec3.cross(res.party.dir, V(0, 1, 0));
    //     // let xDist = vec3.dot(toParty, partyX);
    //     const toPartyX = x - res.party.pos[0];
    //     const toPartyZ = z - res.party.pos[2];
    //     const dirX = res.party.dir[0];
    //     const dirZ = res.party.dir[2];
    //     const zDist = toPartyX * dirX + toPartyZ * dirZ;
    //     const xDist = toPartyX * -dirZ + toPartyZ * dirX;
    //     console.log(`zDist: ${zDist}, xDist: ${xDist}`);

    //     if (Math.abs(zDist) < shipW * 0.5 && Math.abs(xDist) < shipH * 0.5) {
    //       const idx = xi + yi * res.land.worldWidth;

    //       const color = res.levelMap.land[idx];
    //       console.log(color);
    //     }
    //   }
    // }
  },
  "landShipCollision"
);