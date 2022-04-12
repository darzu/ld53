// player controller component and system

import { mat4, quat, vec2, vec3 } from "../gl-matrix.js";
import { Inputs, InputsDef } from "../inputs.js";
import {
  Component,
  EM,
  Entity,
  EntityManager,
  EntityW,
} from "../entity-manager.js";
import { PhysicsTimerDef, Timer } from "../time.js";
import { ColorDef } from "../color.js";
import { FinishedDef } from "../build.js";
import {
  CameraView,
  CameraViewDef,
  RenderableConstructDef,
  RenderableDef,
} from "../render/renderer.js";
import {
  Frame,
  PhysicsParent,
  PhysicsParentDef,
  Position,
  PositionDef,
  Rotation,
  RotationDef,
  ScaleDef,
} from "../physics/transform.js";
import {
  PhysicsResults,
  PhysicsResultsDef,
  WorldFrameDef,
} from "../physics/nonintersection.js";
import {
  Authority,
  AuthorityDef,
  Me,
  MeDef,
  SyncDef,
} from "../net/components.js";
import { AABBCollider, Collider, ColliderDef } from "../physics/collider.js";
import { copyAABB, createAABB, Ray, RayHit } from "../physics/broadphase.js";
import { tempQuat, tempVec } from "../temp-pool.js";
import { Mesh, scaleMesh, scaleMesh3 } from "../render/mesh-pool.js";
import { Assets, AssetsDef, CUBE_FACES } from "./assets.js";
import { LinearVelocity, LinearVelocityDef } from "../physics/motion.js";
import { MotionSmoothingDef } from "../motion-smoothing.js";
import { getCursor, GlobalCursor3dDef } from "./cursor.js";
import { ModelerDef, screenPosToRay } from "./modeler.js";
import { PhysicsDbgDef } from "../physics/phys-debug.js";
import { DeletedDef } from "../delete.js";
import { createNoodleMesh, Noodle, NoodleDef, NoodleSeg } from "./noodles.js";
import { assert } from "../test.js";
import { vec3Dbg, vec3Mid } from "../utils-3d.js";
import { min } from "../math.js";
import { GroundLocalDef } from "./ground.js";
import { ShipLocalDef } from "./ship.js";
import { CameraDef } from "../camera.js";

// TODO(@darzu): it'd be great if these could hook into some sort of
//    dev mode you could toggle at runtime.
export const CHEAT = false;

export const PlayerEntDef = EM.defineComponent("player", (gravity?: number) => {
  return {
    mode: "jumping" as "jumping" | "flying",
    jumpSpeed: 0.003,
    gravity: gravity ?? 0.1,
    // hat stuff
    // TODO(@darzu): better abstraction
    hat: 0,
    tool: 0,
    interacting: false,
    clicking: false,
    manning: false,
    dropping: false,
    targetCursor: -1,
    targetEnt: -1,
    leftLegId: 0,
    rightLegId: 0,
    // disabled noodle limbs
    // leftFootWorldPos: [0, 0, 0] as vec3,
    // rightFootWorldPos: [0, 0, 0] as vec3,
  };
});
export type PlayerEnt = Component<typeof PlayerEntDef>;

// Resource pointing at the local player
export const LocalPlayerDef = EM.defineComponent(
  "localPlayer",
  (playerId?: number) => ({
    playerId: playerId || 0,
  })
);

export const PlayerConstructDef = EM.defineComponent(
  "playerConstruct",
  (loc?: vec3) => {
    return {
      location: loc ?? vec3.create(),
    };
  }
);
export type PlayerConstruct = Component<typeof PlayerConstructDef>;

EM.registerSerializerPair(
  PlayerConstructDef,
  (c, writer) => {
    writer.writeVec3(c.location);
  },
  (c, reader) => {
    reader.readVec3(c.location);
  }
);

export function registerStepPlayers(em: EntityManager) {
  em.registerSystem(
    [
      PlayerEntDef,
      PositionDef,
      RotationDef,
      LinearVelocityDef,
      AuthorityDef,
      PhysicsParentDef,
      WorldFrameDef,
    ],
    [
      PhysicsTimerDef,
      CameraDef,
      InputsDef,
      MeDef,
      PhysicsResultsDef,
      CameraViewDef,
      ModelerDef,
    ],
    (players, res) => {
      for (let i = 0; i < res.physicsTimer.steps; i++) {
        const {
          physicsTimer: { period: dt },
          inputs,
          camera,
          physicsResults: { checkRay },
          cameraView,
        } = res;
        //console.log(`${players.length} players, ${hats.length} hats`);

        for (let p of players) {
          if (p.authority.pid !== res.me.pid) continue;

          if (CHEAT && inputs.keyClicks["f"])
            p.player.mode = p.player.mode === "jumping" ? "flying" : "jumping";

          // fall with gravity
          if (p.player.mode === "jumping") {
            // TODO(@darzu): what r the units of gravity here?
            p.linearVelocity[1] -= (p.player.gravity / 1000) * dt;
          } else {
            p.linearVelocity[1] = 0;
          }

          // move player
          let vel = vec3.fromValues(0, 0, 0);
          let playerSpeed = 0.0005;
          if (inputs.keyDowns["shift"]) playerSpeed *= 3;
          let trans = playerSpeed * dt;
          if (!p.player.manning) {
            if (inputs.keyDowns["a"]) {
              vec3.add(vel, vel, vec3.fromValues(-trans, 0, 0));
            }
            if (inputs.keyDowns["d"]) {
              vec3.add(vel, vel, vec3.fromValues(trans, 0, 0));
            }
            if (inputs.keyDowns["w"]) {
              vec3.add(vel, vel, vec3.fromValues(0, 0, -trans));
            }
            if (inputs.keyDowns["s"]) {
              vec3.add(vel, vel, vec3.fromValues(0, 0, trans));
            }
          }

          if (p.player.mode === "jumping") {
            if (CHEAT && inputs.keyClicks[" "]) {
              p.linearVelocity[1] = p.player.jumpSpeed * dt;
            }
          } else {
            if (inputs.keyDowns[" "]) {
              vec3.add(vel, vel, vec3.fromValues(0, trans, 0));
            } else if (inputs.keyDowns["c"]) {
              vec3.add(vel, vel, vec3.fromValues(0, -trans, 0));
            }
          }

          // console.log(vel);

          vec3.transformQuat(vel, vel, p.rotation);

          // vec3.add(player.linearVelocity, player.linearVelocity, vel);

          // x and z from local movement
          p.linearVelocity[0] = vel[0];
          p.linearVelocity[2] = vel[2];
          if (p.player.mode === "flying") p.linearVelocity[1] = vel[1];

          // TODO(@darzu): rework to use phsyiscs colliders
          if (inputs.keyClicks["e"]) {
            p.player.interacting = true;
          } else {
            p.player.interacting = false;
          }
          if (inputs.lclick) {
            p.player.clicking = true;
          } else {
            p.player.clicking = false;
          }

          p.player.dropping = (inputs.keyClicks["q"] || 0) > 0;

          // TODO(@darzu): we need a better way, maybe some sort of stack,
          //    to hand off mouse etc between systems
          if (res.modeler.mode === "" && !p.player.manning) {
            quat.rotateY(p.rotation, p.rotation, -inputs.mouseMovX * 0.001);
            quat.rotateX(
              camera.rotation,
              camera.rotation,
              -inputs.mouseMovY * 0.001
            );
          }

          let facingDir = vec3.fromValues(0, 0, -1);
          vec3.transformQuat(facingDir, facingDir, p.world.rotation);

          const targetCursor = EM.findEntity(p.player.targetCursor, [
            WorldFrameDef,
          ]);
          if (targetCursor) {
            vec3.sub(facingDir, targetCursor.world.position, p.world.position);
            vec3.normalize(facingDir, facingDir);
          }
          // add bullet on lclick
          if (CHEAT && inputs.lclick) {
            const linearVelocity = vec3.scale(vec3.create(), facingDir, 0.02);
            // TODO(@darzu): adds player motion
            // bulletMotion.linearVelocity = vec3.add(
            //   bulletMotion.linearVelocity,
            //   bulletMotion.linearVelocity,
            //   player.linearVelocity
            // );
            const angularVelocity = vec3.scale(vec3.create(), facingDir, 0.01);
            // spawnBullet(
            //   EM,
            //   vec3.clone(p.world.position),
            //   linearVelocity,
            //   angularVelocity
            // );
            // TODO: figure out a better way to do this
            inputs.lclick = false;
          }
          if (CHEAT && inputs.rclick) {
            const SPREAD = 5;
            const GAP = 1.0;
            for (let xi = 0; xi <= SPREAD; xi++) {
              for (let yi = 0; yi <= SPREAD; yi++) {
                const x = (xi - SPREAD / 2) * GAP;
                const y = (yi - SPREAD / 2) * GAP;
                let bullet_axis = vec3.fromValues(0, 0, -1);
                bullet_axis = vec3.transformQuat(
                  bullet_axis,
                  bullet_axis,
                  p.rotation
                );
                const position = vec3.add(
                  vec3.create(),
                  p.world.position,
                  vec3.fromValues(x, y, 0)
                );
                const linearVelocity = vec3.scale(
                  vec3.create(),
                  bullet_axis,
                  0.005
                );
                vec3.add(linearVelocity, linearVelocity, p.linearVelocity);
                const angularVelocity = vec3.scale(
                  vec3.create(),
                  bullet_axis,
                  0.01
                );
                // spawnBullet(EM, position, linearVelocity, angularVelocity);
              }
            }
          }

          // shoot a ray
          if (CHEAT && inputs.keyClicks["r"]) {
            // create our ray
            const r: Ray = {
              org: vec3.add(
                vec3.create(),
                p.world.position,
                vec3.scale(
                  tempVec(),
                  vec3.multiply(tempVec(), facingDir, p.world.scale),
                  3.0
                )
              ),
              dir: facingDir,
            };
            playerShootRay(r);
          }

          // change physics parent
          if (CHEAT && inputs.keyClicks["t"]) {
            const targetEnt = EM.findEntity(p.player.targetEnt, [ColliderDef]);
            if (targetEnt) {
              p.physicsParent.id = targetEnt.id;
              vec3.copy(p.position, [0, 0, 0]);
              if (targetEnt.collider.shape === "AABB") {
                // move above the obj
                p.position[1] = targetEnt.collider.aabb.max[1] + 3;
              }
              vec3.copy(p.linearVelocity, vec3.ZEROS);
            } else {
              // unparent
              p.physicsParent.id = 0;
            }
          }

          // delete object
          if (
            CHEAT &&
            res.inputs.keyClicks["backspace"] &&
            p.player.targetEnt > 0
          ) {
            em.ensureComponent(p.player.targetEnt, DeletedDef);
          }

          function playerShootRay(r: Ray) {
            // check for hits
            const hits = checkRay(r);
            const firstHit = hits.reduce((p, n) => (n.dist < p.dist ? n : p), {
              dist: Infinity,
              id: -1,
            });
            const doesHit = firstHit.id !== -1;

            if (doesHit) {
              // increase green
              const e = EM.findEntity(firstHit.id, [ColorDef]);
              if (e) {
                e.color[1] += 0.1;
              }
            }

            // draw our ray
            const rayDist = doesHit ? firstHit.dist : 1000;
            const color: vec3 = doesHit ? [0, 1, 0] : [1, 0, 0];
            const endPoint = vec3.add(
              vec3.create(),
              r.org,
              vec3.scale(tempVec(), r.dir, rayDist)
            );
            // drawLine(EM, r.org, endPoint, color);
          }
        }
      }
    },
    "stepPlayers"
  );

  em.registerSystem(
    [PlayerEntDef, PositionDef, RotationDef, AuthorityDef],
    [
      CameraViewDef,
      CameraDef,
      GlobalCursor3dDef,
      MeDef,
      PhysicsResultsDef,
      InputsDef,
    ],
    (players, res) => {
      const p = players.filter((p) => p.authority.pid === res.me.pid)[0];
      const c = getCursor(em, [PositionDef, RenderableDef, ColorDef]);
      if (p && c) {
        if (res.camera.cameraMode !== "thirdPersonOverShoulder") {
          // hide the cursor
          c.renderable.enabled = false;
          // target nothing
          p.player.targetCursor = -1;
          p.player.targetEnt = -1;
        } else {
          // show the cursor
          c.renderable.enabled = true;

          // target the cursor
          p.player.targetCursor = c.id;

          // shoot a ray from screen center to figure out where to put the cursor
          const screenMid: vec2 = [
            res.cameraView.width * 0.5,
            res.cameraView.height * 0.4,
          ];
          const r = screenPosToRay(screenMid, res.cameraView);
          let cursorDistance = 100;

          // if we hit something with that ray, put the cursor there
          const hits = res.physicsResults.checkRay(r);
          let nearestHit: RayHit = { dist: Infinity, id: -1 };
          if (hits.length) {
            nearestHit = hits.reduce(
              (p, n) => (n.dist < p.dist ? n : p),
              nearestHit
            );
            cursorDistance = nearestHit.dist;
            vec3.copy(c.color, [0, 1, 0]);

            // remember what we hit
            p.player.targetEnt = nearestHit.id;
          } else {
            vec3.copy(c.color, [0, 1, 1]);
          }

          // place the cursor
          vec3.add(
            c.position,
            r.org,
            vec3.scale(tempVec(), r.dir, cursorDistance)
          );
        }
      }
    },
    "playerCursorUpdate"
  );

  em.registerSystem(
    [PlayerEntDef, AuthorityDef, PositionDef, LinearVelocityDef],
    [PhysicsResultsDef, MeDef],
    (players, res) => {
      for (let p of players) {
        if (p.authority.pid !== res.me.pid) continue;

        function changeParent(parent: EntityW<[typeof ColliderDef]>) {
          // already on this ship
          if (PhysicsParentDef.isOn(p))
            if (p.physicsParent.id === parent.id) return;

          console.log(`new parent: ${parent.id}`);

          em.ensureComponentOn(p, PhysicsParentDef);

          p.physicsParent.id = parent.id;
          vec3.copy(p.position, [0, 0, 0]);
          if (parent.collider.shape === "AABB") {
            // move above the obj
            p.position[1] = parent.collider.aabb.max[1] + 3;
          }
          vec3.copy(p.linearVelocity, vec3.ZEROS);
        }

        const shipHits = res.physicsResults.collidesWith
          .get(p.id)
          ?.map((h) => em.findEntity(h, [ShipLocalDef, ColliderDef]));

        if (shipHits && shipHits.length && shipHits[0]) {
          const ship = shipHits[0];
          changeParent(ship);
          continue;
        }

        // TODO(@darzu): trying to reparent to the ground, doesnt work
        // const groundHits = res.physicsResults.collidesWith
        //   .get(p.id)
        //   ?.map((h) => em.findEntity(h, [GroundDef, ColliderDef]));

        // if (groundHits && groundHits.length && groundHits[0]) {
        //   const ground = groundHits[0];
        //   changeParent(ground);
        //   continue;
        // }
      }
    },
    "playerOnShip"
  );
}

// TODO(@darzu): move this helper elsewhere?
export function drawLine(
  em: EntityManager,
  start: vec3,
  end: vec3,
  color: vec3
) {
  const { id } = em.newEntity();
  em.addComponent(id, ColorDef, color);
  const m: Mesh = {
    pos: [start, end],
    tri: [],
    colors: [],
    lines: [[0, 1]],
    usesProvoking: true,
  };
  em.addComponent(id, RenderableConstructDef, m);
  em.addComponent(id, WorldFrameDef);
}

export let __lastPlayerId = 0;

export function registerBuildPlayersSystem(em: EntityManager) {
  em.registerSystem(
    [PlayerConstructDef],
    [MeDef, AssetsDef],
    (players, res) => {
      for (let e of players) {
        if (FinishedDef.isOn(e)) continue;
        __lastPlayerId = e.id; // TODO(@darzu): debugging
        const props = e.playerConstruct;
        if (!PositionDef.isOn(e))
          em.addComponent(e.id, PositionDef, props.location);
        if (!RotationDef.isOn(e))
          em.addComponent(
            e.id,
            RotationDef,
            quat.rotateY(quat.create(), quat.IDENTITY, Math.PI)
          );
        if (!LinearVelocityDef.isOn(e))
          em.addComponent(e.id, LinearVelocityDef);
        if (!ColorDef.isOn(e)) em.addComponent(e.id, ColorDef, [0, 0.2, 0]);
        if (!MotionSmoothingDef.isOn(e))
          em.addComponent(e.id, MotionSmoothingDef);
        if (!RenderableConstructDef.isOn(e)) {
          const m = scaleMesh3(res.assets.cube.mesh, [0.75, 0.75, 0.4]);
          em.addComponent(e.id, RenderableConstructDef, m);
        }
        if (!AuthorityDef.isOn(e))
          em.addComponent(e.id, AuthorityDef, res.me.pid);
        if (!PlayerEntDef.isOn(e)) {
          em.ensureComponentOn(e, PlayerEntDef);

          // create legs
          function makeLeg(x: number): Entity {
            const l = em.newEntity();
            em.ensureComponentOn(l, PositionDef, [x, -1.5, 0]);
            em.ensureComponentOn(
              l,
              RenderableConstructDef,
              res.assets.cube.proto
            );
            em.ensureComponentOn(l, ScaleDef, [0.15, 0.75, 0.15]);
            em.ensureComponentOn(l, ColorDef, [0.05, 0.05, 0.05]);
            em.ensureComponentOn(l, PhysicsParentDef, e.id);
            return l;
          }
          e.player.leftLegId = makeLeg(-0.5).id;
          e.player.rightLegId = makeLeg(0.5).id;
        }
        if (!ColliderDef.isOn(e)) {
          const collider = em.addComponent(e.id, ColliderDef);
          collider.shape = "AABB";
          collider.solid = true;
          const playerAABB = copyAABB(createAABB(), res.assets.cube.aabb);
          vec3.add(playerAABB.min, playerAABB.min, [0, -1, 0]);
          (collider as AABBCollider).aabb = playerAABB;
        }
        if (!SyncDef.isOn(e)) {
          em.ensureComponentOn(e, SyncDef, [
            PositionDef.id,
            RotationDef.id,
            // TODO(@darzu): maybe sync this via events instead
            PhysicsParentDef.id,
          ]);
          e.sync.fullComponents = [PlayerConstructDef.id];
        }
        em.ensureComponent(e.id, PhysicsParentDef);
        em.addComponent(e.id, FinishedDef);
      }
    },
    "buildPlayers"
  );
}
