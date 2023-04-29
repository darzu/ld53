import { AssetsDef } from "../assets.js";
import { ColorDef } from "../color-ecs.js";
import { ENDESGA16 } from "../color/palettes.js";
import { createRef, Ref } from "../em_helpers.js";
import { EM, Entity, EntityW } from "../entity-manager.js";
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
import { RenderableConstructDef } from "../render/renderer-ecs.js";
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
}

export const StoneTowerDef = EM.defineComponent(
  "stoneTower",
  (
    cannon: EntityW<
      [typeof PositionDef, typeof RotationDef, typeof WorldFrameDef]
    >,
    fireRate = 1000,
    projectileSpeed = 0.1
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
    console.log(`right face out of AABB at index ${baseIndex}`);
    face = rightFace;
  } else if (
    leftFace.every(
      (index) => !pointInAABB(aabb, tower.mesh.pos[baseIndex + index])
    )
  ) {
    console.log(`left face out of AABB at index ${baseIndex}`);
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
        console.log(`unshrinkable point at ${baseIndex} + ${attractedIndex}`);
        // can't shrink this point enough, giving up
        return false;
      }
      // we can shrink along this axis!
      // iterate for 10 rounds
      for (let i = 0; i < 10; i++) {
        console.log(`iteration ${i}, min=${min}, max=${max}`);
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
      console.log(`done with iterations, max is ${max}`);
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

export async function createStoneTower(
  height: number,
  baseRadius: number,
  approxBrickWidth: number,
  approxBrickHeight: number,
  brickDepth: number,
  coolMode: boolean
) {
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
  const mesh = tower.stoneTower.mesh;

  function calculateNAndBrickWidth(
    radius: number,
    approxBrickWidth: number
  ): [number, number] {
    const n = Math.floor(Math.PI / Math.asin(approxBrickWidth / (2 * radius)));
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
}

let __frame = 0;

const EPSILON = 1.0;

EM.registerSystem(
  [StoneTowerDef, WorldFrameDef],
  [TimeDef, PartyDef],
  (es, res) => {
    __frame++;
    const target = res.party.pos;
    if (!target) return;
    for (let tower of es) {
      if (
        tower.stoneTower.lastFired + tower.stoneTower.fireRate <=
        res.time.time
      ) {
        // we're able to fire. should we?
        const towerSpaceTarget = vec3.transformMat4(
          target,
          mat4.invert(tower.world.transform)
        );

        // is target at Z = 0 in tower-space?
        console.log(`target Z=${towerSpaceTarget[2]}`);
        if (Math.abs(towerSpaceTarget[2]) < EPSILON) {
          // now, find the angle from our cannon.
          const x =
            towerSpaceTarget[0] - tower.stoneTower.cannon()!.position[0];
          const y =
            towerSpaceTarget[1] - tower.stoneTower.cannon()!.position[1];
          const v = tower.stoneTower.projectileSpeed;
          const g = 7.0 * 0.00001;
          // https://en.wikipedia.org/wiki/Projectile_motion#Angle_%CE%B8_required_to_hit_coordinate_(x,_y)
          const theta1 = Math.atan(
            (v * v +
              Math.sqrt(v * v * v * v - g * (g * x * x + 2 * y * v * v))) /
              (g * x)
          );
          const theta2 = Math.atan(
            (v * v -
              Math.sqrt(v * v * v * v - g * (g * x * x + 2 * y * v * v))) /
              (g * x)
          );

          // prefer positive theta
          let theta = theta1;
          if (theta2 > 0) theta = theta2;
          if (isNaN(theta)) {
            // no firing solution--target is too far
            console.log("target is in sights but too far away");
            continue;
          }
          console.log(
            `Firing, theta1 is ${theta1} theta2 is ${theta2} x=${x} y=${y} v=${v} sqrt is ${Math.sqrt(
              v * v * v * v - g * (g * x * x + 2 * y * v * v)
            )}`
          );
          // ok, we have a firing solution. rotate to the right angle and fire
          const rot = tower.stoneTower.cannon()!.rotation;
          quat.identity(rot);
          quat.rotateZ(rot, theta, rot);
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
            2.0,
            [1, 0, 0]
          );
          tower.stoneTower.lastFired = res.time.time;
        }
      }
    }
  },
  "stoneTowerAttack"
);
