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
import { WorldFrameDef } from "../physics/nonintersection.js";
import {
  PhysicsParentDef,
  PositionDef,
  RotationDef,
} from "../physics/transform.js";
import { Mesh } from "../render/mesh.js";
import {
  RenderableConstructDef,
  RenderableDef,
} from "../render/renderer-ecs.js";
import { mat4, tV, V, vec3, quat } from "../sprig-matrix.js";
import { TimeDef } from "../time.js";

interface Brick {
  aabb: AABB;
  // index of first pos in the mesh
  index: number;
  // track whether this brick has been destroyed
  knockedOut: boolean;
}

interface TowerRow {
  aabb: AABB;
  bricks: Array<Brick>;
}

interface Tower {
  rows: Array<TowerRow>;
  mesh: Mesh;
  cannon: Ref<[typeof PositionDef, typeof RotationDef, typeof WorldFrameDef]>;
  lastFired: number;
  fireRate: number;
  projectileSpeed: number;
  firingRadius: number;
}

export const StoneTowerDef = EM.defineComponent(
  "stoneTower",
  (
    cannon: EntityW<
      [typeof PositionDef, typeof RotationDef, typeof WorldFrameDef]
    >,
    fireRate = 2000,
    projectileSpeed = 0.15,
    firingRadius = Math.PI / 8
  ) =>
    ({
      rows: [],
      mesh: {
        pos: [],
        colors: [],
        quad: [],
        tri: [],
        surfaceIds: [],
        usesProvoking: true,
        dbgName: "tower",
      } as Mesh,
      cannon:
        createRef<
          [typeof PositionDef, typeof RotationDef, typeof WorldFrameDef]
        >(cannon),
      lastFired: 0,
      fireRate,
      projectileSpeed,
      firingRadius,
    } as Tower)
);

function knockOutBrickAtIndex(tower: Tower, index: number) {
  for (let i = 0; i < 8; i++) {
    vec3.set(0, 0, 0, tower.mesh.pos[index + i]);
  }
}

let towardsAttractorTmp = vec3.tmp();
let testAABBTmp = vec3.tmp();

function shrinkBrickAtIndex(
  tower: Tower,
  baseIndex: number,
  aabb: AABB
): boolean {
  // is right face entirely outside AABB?
  const rightFace = [0, 2, 4, 6];
  const leftFace = [1, 3, 5, 7];
  let face;
  if (
    rightFace.every(
      (index) => !pointInAABB(aabb, tower.mesh.pos[baseIndex + index])
    )
  ) {
    //console.log(`right face out of AABB at index ${baseIndex}`);
    face = rightFace;
  } else if (
    leftFace.every(
      (index) => !pointInAABB(aabb, tower.mesh.pos[baseIndex + index])
    )
  ) {
    //console.log(`left face out of AABB at index ${baseIndex}`);
    face = leftFace;
  }
  if (!face) {
    // neither face is entirely outside the AABB
    return false;
  }
  for (let index of face) {
    // each point can attract a point across from it along x
    let attractedIndex = index % 2 === 0 ? index + 1 : index - 1;
    let attractor = tower.mesh.pos[baseIndex + index];
    let attracted = tower.mesh.pos[baseIndex + attractedIndex];
    if (pointInAABB(aabb, attractor)) {
      console.log("should never happen");
    }
    if (pointInAABB(aabb, attracted)) {
      let towardsAttractor = vec3.sub(
        attractor,
        attracted,
        towardsAttractorTmp
      );
      let min = 0;
      let max = 0.8; // don't want to shrink bricks too much
      if (
        pointInAABB(
          aabb,
          vec3.add(
            attracted,
            vec3.scale(towardsAttractor, max, testAABBTmp),
            testAABBTmp
          )
        )
      ) {
        //console.log(`unshrinkable point at ${baseIndex} + ${attractedIndex}`);
        // can't shrink this point enough, giving up
        return false;
      }
      // we can shrink along this axis!
      // iterate for 10 rounds
      for (let i = 0; i < 10; i++) {
        //console.log(`iteration ${i}, min=${min}, max=${max}`);
        const half = (min + max) / 2;
        if (
          pointInAABB(
            aabb,
            vec3.add(
              attracted,
              vec3.scale(towardsAttractor, half, testAABBTmp),
              testAABBTmp
            )
          )
        ) {
          min = half;
        } else {
          max = half;
        }
      }
      //console.log(`done with iterations, max is ${max}`);
      vec3.add(attracted, vec3.scale(towardsAttractor, max), attracted);
    }
  }
  return true;
}

// takes a tower-space AABB--not world space!
function knockOutBricks(tower: Tower, aabb: AABB, shrink = false): number {
  let bricksKnockedOut = 0;
  for (let row of tower.rows) {
    if (doesOverlapAABB(row.aabb, aabb)) {
      for (let brick of row.bricks) {
        if (doesOverlapAABB(brick.aabb, aabb)) {
          if (shrink) {
            if (!shrinkBrickAtIndex(tower, brick.index, aabb)) {
              knockOutBrickAtIndex(tower, brick.index);
            }
          } else {
            knockOutBrickAtIndex(tower, brick.index);
            if (!brick.knockedOut) {
              brick.knockedOut = true;
              bricksKnockedOut++;
            }
          }
        }
      }
    }
  }
  return bricksKnockedOut;
}

const maxStoneTowers = 10;

const height: number = 100;
const baseRadius: number = 20;
const approxBrickWidth: number = 5;
const approxBrickHeight: number = 2;
const brickDepth: number = 2.5;
const coolMode: boolean = false;

const towerPool = createEntityPool<
  [typeof StoneTowerDef, typeof PositionDef, typeof RotationDef]
>({
  max: maxStoneTowers,
  maxBehavior: "crash",
  create: async () => {
    const res = await EM.whenResources(AssetsDef);
    const tower = EM.new();
    const cannon = EM.new();
    EM.ensureComponentOn(
      cannon,
      RenderableConstructDef,
      res.assets.ld53_cannon.proto
    );
    EM.ensureComponentOn(cannon, PositionDef);
    EM.ensureComponentOn(cannon, ColorDef, V(0.05, 0.05, 0.05));
    EM.ensureComponentOn(cannon, RotationDef);
    EM.ensureComponentOn(cannon, PhysicsParentDef, tower.id);
    EM.ensureComponentOn(cannon, WorldFrameDef);
    vec3.set(baseRadius - 2, height * 0.7, 0, cannon.position);

    EM.ensureComponentOn(tower, StoneTowerDef, cannon);
    EM.ensureComponentOn(tower, PositionDef);
    EM.ensureComponentOn(tower, RotationDef);
    const mesh = tower.stoneTower.mesh;

    function calculateNAndBrickWidth(
      radius: number,
      approxBrickWidth: number
    ): [number, number] {
      const n = Math.floor(
        Math.PI / Math.asin(approxBrickWidth / (2 * radius))
      );
      const brickWidth = radius * 2 * Math.sin(Math.PI / n);
      return [n, brickWidth];
    }

    const rows = Math.floor(height / approxBrickHeight);
    const brickHeight = height / rows;

    const cursor = mat4.create();
    function applyCursor(v: vec3, distort: boolean = false): vec3 {
      vec3.transformMat4(v, cursor, v);
      if (distort)
        vec3.add(
          v,
          [
            jitter(approxBrickWidth / 10),
            jitter(brickHeight / 10),
            jitter(brickDepth / 10),
          ],
          v
        );
      return v;
    }
    function appendBrick(brickWidth: number, brickDepth: number): Brick {
      const index = mesh.pos.length;
      const aabb = createAABB();
      // base
      function addPos(p: vec3) {
        mesh.pos.push(p);
        updateAABBWithPoint(aabb, p);
      }
      addPos(applyCursor(V(0, 0, 0)));
      addPos(applyCursor(V(0 + brickWidth, 0, 0)));
      addPos(applyCursor(V(0, 0, 0 + brickDepth), true));
      addPos(applyCursor(V(0 + brickWidth, 0, 0 + brickDepth), true));

      //top
      addPos(applyCursor(V(0, 0 + brickHeight, 0)));
      addPos(applyCursor(V(0 + brickWidth, 0 + brickHeight, 0)));
      addPos(applyCursor(V(0, 0 + brickHeight, 0 + brickDepth), true));
      addPos(
        applyCursor(V(0 + brickWidth, 0 + brickHeight, 0 + brickDepth), true)
      );

      // base
      mesh.quad.push(V(index, index + 1, index + 3, index + 2));

      // top
      mesh.quad.push(V(index + 4, index + 2 + 4, index + 3 + 4, index + 1 + 4));

      // sides
      mesh.quad.push(V(index, index + 4, index + 1 + 4, index + 1));
      mesh.quad.push(V(index, index + 2, index + 2 + 4, index + 4));
      mesh.quad.push(V(index + 2, index + 3, index + 3 + 4, index + 2 + 4));
      mesh.quad.push(V(index + 1, index + 1 + 4, index + 3 + 4, index + 3));
      //
      const brightness = Math.random() * 0.05;
      const color = V(brightness, brightness, brightness);
      for (let i = 0; i < 6; i++) {
        mesh.colors.push(color);
      }
      return { aabb, index, knockedOut: false };
    }

    let rotation = 0;
    for (let r = 0; r < rows; r++) {
      const row: TowerRow = { aabb: createAABB(), bricks: [] };
      tower.stoneTower.rows.push(row);
      const radius = baseRadius * (1 - r / (rows * 2));
      const [n, brickWidth] = calculateNAndBrickWidth(radius, approxBrickWidth);
      const angle = (2 * Math.PI) / n;
      mat4.identity(cursor);
      mat4.translate(cursor, [0, r * brickHeight, 0], cursor);
      rotation += angle / 2;
      rotation += jitter(angle / 4);
      mat4.rotateY(cursor, rotation, cursor);
      mat4.translate(cursor, [0, 0, radius], cursor);
      mat4.rotateY(cursor, coolMode ? -angle / 2 : angle / 2, cursor);
      for (let i = 0; i < n; i++) {
        const brick = appendBrick(
          brickWidth,
          brickDepth + jitter(brickDepth / 10)
        );
        mergeAABBs(row.aabb, row.aabb, brick.aabb);
        row.bricks.push(brick);
        if (coolMode) {
          mat4.rotateY(cursor, angle, cursor);
          mat4.translate(cursor, [brickWidth, 0, 0], cursor);
        } else {
          mat4.translate(cursor, [brickWidth, 0, 0], cursor);
          mat4.rotateY(cursor, angle, cursor);
        }
      }
    }
    //mesh.quad.forEach(() => mesh.colors.push(V(0, 0, 0)));
    mesh.quad.forEach((_, i) => mesh.surfaceIds.push(i + 1));
    const windowHeight = 0.7 * height;
    const windowAABB: AABB = {
      min: V(
        baseRadius - 4 * brickDepth,
        windowHeight - 2 * brickHeight,
        -approxBrickWidth
      ),
      max: V(
        baseRadius + 2 * brickDepth,
        windowHeight + 2 * brickHeight,
        approxBrickWidth
      ),
    };
    knockOutBricks(tower.stoneTower, windowAABB, true);
    EM.ensureComponentOn(tower, RenderableConstructDef, mesh);
    return tower;
  },
  onSpawn: async (p) => {
    // platform.towerPlatform.tiltPeriod = tiltPeriod;
    // platform.towerPlatform.tiltTimer = tiltTimer;
    p.stoneTower.lastFired = 0;
  },
  onDespawn: (e) => {
    // tower
    if (!DeadDef.isOn(e)) {
      // dead platform
      EM.ensureComponentOn(e, DeadDef);
      if (RenderableDef.isOn(e)) e.renderable.hidden = true;
      e.dead.processed = true;

      // dead cannon
      if (e.stoneTower.cannon()) {
        const c = e.stoneTower.cannon()!;
        EM.ensureComponentOn(c, DeadDef);
        if (RenderableDef.isOn(c)) c.renderable.hidden = true;
        c.dead.processed = true;
      }
    }
  },
});

export async function spawnStoneTower() {
  return towerPool.spawn();
}

const __previousPartyPos = vec3.create();
let __prevTime = 0;

const MAX_THETA = (31 * Math.PI) / 64;
const MIN_THETA = -(31 * Math.PI) / 64;
const THETA_JITTER = Math.PI / 128;
const PHI_JITTER = Math.PI / 32;

EM.registerSystem(
  [StoneTowerDef, WorldFrameDef],
  [TimeDef, PartyDef],
  (es, res) => {
    const target = res.party.pos;
    if (!target) return;
    for (let tower of es) {
      const invertedTransform = mat4.invert(tower.world.transform);
      const towerSpaceTarget = vec3.transformMat4(target, invertedTransform);
      const prevTowerSpaceTarget = vec3.transformMat4(
        __previousPartyPos,
        invertedTransform
      );

      const targetVelocity = vec3.scale(
        vec3.sub(towerSpaceTarget, prevTowerSpaceTarget),
        1 / (res.time.time - __prevTime)
      );

      /*
      const zvelocity = targetVelocity[2];

      const timeToZZero = -(towerSpaceTarget[2] / zvelocity);
      if (timeToZZero < 0) {
        // it's moving away, don't worry about it
        continue;
      }

      // what will the x position be, relative to the cannon, when z = 0?
      const x =
        towerSpaceTarget[0] +
        targetVelocity[0] * timeToZZero -
        tower.stoneTower.cannon()!.position[0];
      // y is probably constant, but calculate it just for fun
      const y =
        towerSpaceTarget[1] +
        targetVelocity[1] * timeToZZero -
        tower.stoneTower.cannon()!.position[1];
      console.log(`timeToZZero=${timeToZZero}`);
      */

      const v = tower.stoneTower.projectileSpeed;
      const g = 10.0 * 0.00001;

      let x = towerSpaceTarget[0] - tower.stoneTower.cannon()!.position[0];
      const y = towerSpaceTarget[1] - tower.stoneTower.cannon()!.position[1];
      let z = towerSpaceTarget[2];

      // try to lead the target a bit using an approximation of flight
      // time. this will not be exact.
      const flightTime = x / (v * Math.cos(Math.PI / 4));
      z = z + targetVelocity[2] * flightTime;
      x = x + targetVelocity[2] * flightTime;

      if (x < 0) {
        // target is behind us, don't worry about it
        continue;
      }

      let phi = -Math.atan(z / x);

      if (Math.abs(phi) > tower.stoneTower.firingRadius) {
        continue;
      }

      x = Math.sqrt(x * x + z * z);

      // now, find the angle from our cannon.
      // https://en.wikipedia.org/wiki/Projectile_motion#Angle_%CE%B8_required_to_hit_coordinate_(x,_y)
      const theta1 = Math.atan(
        (v * v + Math.sqrt(v * v * v * v - g * (g * x * x + 2 * y * v * v))) /
          (g * x)
      );
      const theta2 = Math.atan(
        (v * v - Math.sqrt(v * v * v * v - g * (g * x * x + 2 * y * v * v))) /
          (g * x)
      );

      // prefer smaller theta
      let theta = theta1;
      if (theta2 < theta1) theta = theta2;
      if (isNaN(theta) || theta > MAX_THETA || theta < MIN_THETA) {
        // no firing solution--target is too far or too close
        //console.log("target is in sights but too far away");
        continue;
      }
      // console.log(
      //   `Firing solution found, theta1 is ${theta1} theta2 is ${theta2} x=${x} y=${y} v=${v} sqrt is ${Math.sqrt(
      //     v * v * v * v - g * (g * x * x + 2 * y * v * v)
      //   )}`
      // );
      // ok, we have a firing solution. rotate to the right angle

      const rot = tower.stoneTower.cannon()!.rotation;
      quat.identity(rot);
      quat.rotateZ(rot, theta, rot);
      quat.rotateY(rot, phi, rot);

      // fire if we are within a couple of frames
      /*
      console.log(`flightTime=${flightTime} timeToZZero=${timeToZZero}`);
      if (Math.abs(flightTime - timeToZZero) > 32) {
        continue;
      }*/
      // maybe we can't actually fire yet?
      if (
        tower.stoneTower.lastFired + tower.stoneTower.fireRate >
        res.time.time
      ) {
        continue;
      }
      // when we fire, add some jitter to both theta and phi
      quat.rotateZ(rot, jitter(THETA_JITTER), rot);
      quat.rotateZ(rot, jitter(PHI_JITTER), rot);
      const worldRot = quat.create();
      mat4.getRotation(
        mat4.mul(tower.world.transform, mat4.fromQuat(rot)),
        worldRot
      );
      fireBullet(
        EM,
        2,
        tower.stoneTower.cannon()!.world.position,
        worldRot,
        v,
        0.02,
        g,
        // 2.0,
        20.0,
        [1, 0, 0]
      );
      tower.stoneTower.lastFired = res.time.time;
    }
    vec3.copy(__previousPartyPos, target);
    __prevTime = res.time.time;
  },
  "stoneTowerAttack"
);