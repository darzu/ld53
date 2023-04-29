import {
  CameraDef,
  CameraFollowDef,
  setCameraFollowPosition,
} from "../camera.js";
import { ColorDef } from "../color-ecs.js";
import { ENDESGA16 } from "../color/palettes.js";
import { EM, EntityManager, EntityW } from "../entity-manager.js";
import { AssetsDef, gameMeshFromMesh } from "../assets.js";
import { ControllableDef } from "../games/controllable.js";
import { createGhost, GhostDef } from "../games/ghost.js";
import { LocalPlayerDef, PlayerDef } from "../games/player.js";
import {
  createGrassTile,
  createGrassTileset,
  GrassTileOpts,
  GrassTilesetOpts,
} from "../grass.js";
import { AuthorityDef, MeDef } from "../net/components.js";
import { ColliderDef } from "../physics/collider.js";
import { AngularVelocityDef, LinearVelocityDef } from "../physics/motion.js";
import { PhysicsStateDef, WorldFrameDef } from "../physics/nonintersection.js";
import {
  PhysicsParentDef,
  PositionDef,
  RotationDef,
  ScaleDef,
} from "../physics/transform.js";
import { PointLightDef } from "../render/lights.js";
import { cloneMesh, mapMeshPositions, transformMesh } from "../render/mesh.js";
import { stdRenderPipeline } from "../render/pipelines/std-mesh.js";
import { outlineRender } from "../render/pipelines/std-outline.js";
import { postProcess } from "../render/pipelines/std-post.js";
import {
  shadowDepthTextures,
  shadowPipelines,
} from "../render/pipelines/std-shadow.js";
import { RenderableConstructDef, RendererDef } from "../render/renderer-ecs.js";
import { mat3, mat4, quat, V, vec2, vec3, vec4 } from "../sprig-matrix.js";
import {
  quatFromUpForward,
  randNormalPosVec3,
  randNormalVec3,
  vec3Dbg,
} from "../utils-3d.js";
import { randColor } from "../utils-game.js";
import { DevConsoleDef } from "../console.js";
import { clamp, jitter, max, sum } from "../math.js";
import { CY } from "../render/gpu-registry.js";
import { assert } from "../util.js";
import { texTypeToBytes } from "../render/gpu-struct.js";
import { PartyDef } from "../games/party.js";
import { copyAABB, createAABB, getAABBCornersTemp } from "../physics/aabb.js";
import { rasterizeTri } from "../raster.js";
import { InputsDef } from "../inputs.js";
import { raiseManTurret } from "../games/turret.js";
import { TextDef } from "../games/ui.js";
import { VERBOSE_LOG } from "../flags.js";
import { CanvasDef } from "../canvas.js";
import { createJfaPipelines } from "../render/pipelines/std-jump-flood.js";
import { createGridComposePipelines } from "../render/pipelines/std-compose.js";
import { createTextureReader } from "../render/cpu-texture.js";
import { initOcean, OceanDef } from "../games/hyperspace/ocean.js";
import { renderOceanPipe } from "../render/pipelines/std-ocean.js";
import { SKY_MASK } from "../render/pipeline-masks.js";
import { skyPipeline } from "../render/pipelines/std-sky.js";
import { createFlatQuadMesh, makeDome } from "../primatives.js";
import { deferredPipeline } from "../render/pipelines/std-deferred.js";
import { startTowers } from "../games/tower.js";
import { createGraph3DAxesMesh, createGraph3DDataMesh } from "../gizmos.js";
import { createGraph3D } from "../utils-gizmos.js";
import { ScoreDef } from "../smol/score.js";
import { LandMapTexPtr, LevelMapDef, setMap } from "../smol/level-map.js";
import { GrassCutTexPtr, grassPoolPtr } from "../smol/std-grass.js";
import { WindDef } from "../smol/wind.js";
import { createShip, ShipDef } from "../smol/ship.js";
import { SAIL_FURL_RATE } from "../smol/sail.js";
import { createStoneTower } from "./stone.js";

/*
NOTES:
- Cut grass by updating a texture that has cut/not cut or maybe cut-height

TODO:
Shading and appearance
[ ] fix shadow mapping
[ ] shading from skybox
[ ] cooler and warmer shading from "sun" and skybox
[ ] bring back some gradient on terrain
PERF:
[ ] reduce triangles on terrain
[ ] reduce triangles on ocean
*/

const DBG_PLAYER = true;

// world map is centered around 0,0
const WORLD_WIDTH = 1024; // width runs +z
const WORLD_HEIGHT = 512; // height runs +x

const RED_DAMAGE_CUTTING = 10;
const RED_DAMAGE_PER_FRAME = 40;
const GREEN_HEALING = 1;

// const SHIP_START_POS: vec3 = V(0, 2, -WORLD_WIDTH * 0.5 * 0.8);

// const WORLD_HEIGHT = 1024;

const worldXToTexY = (x: number) => Math.floor(x + WORLD_HEIGHT / 2);
const worldZToTexX = (z: number) => Math.floor(z + WORLD_WIDTH / 2);
const texXToWorldZ = (x: number) => x - WORLD_WIDTH / 2 + 0.5;
const texYToWorldX = (y: number) => y - WORLD_HEIGHT / 2 + 0.5;

const level2DtoWorld3D = (levelPos: vec2, y: number, out: vec3) =>
  vec3.set(
    texYToWorldX(WORLD_HEIGHT - 1 - levelPos[1]),
    y,
    texXToWorldZ(levelPos[0]),
    out
  );

export const mapJfa = createJfaPipelines(LandMapTexPtr, "exterior");

export async function initLD53(em: EntityManager, hosting: boolean) {
  const dbgGrid = [
    //
    [mapJfa._inputMaskTex, mapJfa._uvMaskTex],
    //
    // [mapJfa.voronoiTex, mapJfa.sdfTex],
    // TODO(@darzu): FIX FOR CSM & texture arrays
    [
      { ptr: shadowDepthTextures, idx: 0 },
      { ptr: shadowDepthTextures, idx: 1 },
    ],
  ];
  let dbgGridCompose = createGridComposePipelines(dbgGrid);

  // TODO(@darzu): HACK. these have to be set before the CY instantiator runs.
  outlineRender.fragOverrides!.lineWidth = 1.0;

  const res = await em.whenResources(
    AssetsDef,
    // WoodAssetsDef,
    // GlobalCursor3dDef,
    RendererDef,
    CameraDef
  );

  res.camera.fov = Math.PI * 0.5;
  copyAABB(
    res.camera.maxWorldAABB,
    createAABB(
      V(-WORLD_HEIGHT * 1.1, -100, -WORLD_WIDTH * 1.1),
      V(WORLD_HEIGHT * 1.1, 100, WORLD_WIDTH * 1.1)
    )
  );

  // console.dir(mapJfa);
  // console.dir(dbgGridCompose);

  em.registerSystem(
    null,
    [RendererDef, DevConsoleDef],
    (_, res) => {
      // renderer
      res.renderer.pipelines = [
        ...shadowPipelines,
        stdRenderPipeline,
        // renderGrassPipe,
        renderOceanPipe,
        outlineRender,
        deferredPipeline,
        skyPipeline,
        postProcess,
        ...(res.dev.showConsole ? dbgGridCompose : []),
      ];
    },
    "smolGameRenderPipelines"
  );
  em.requireSystem("smolGameRenderPipelines");

  // Sun
  const sunlight = em.new();
  em.ensureComponentOn(sunlight, PointLightDef);
  // sunlight.pointLight.constant = 1.0;
  sunlight.pointLight.constant = 1.0;
  sunlight.pointLight.linear = 0.0;
  sunlight.pointLight.quadratic = 0.0;
  vec3.copy(sunlight.pointLight.ambient, [0.2, 0.2, 0.2]);
  vec3.copy(sunlight.pointLight.diffuse, [0.5, 0.5, 0.5]);
  em.ensureComponentOn(sunlight, PositionDef, V(50, 300, 10));
  em.ensureComponentOn(sunlight, RenderableConstructDef, res.assets.ball.proto);

  // score
  const score = em.addResource(ScoreDef);
  em.requireSystem("updateScoreDisplay");
  em.requireSystem("detectGameEnd");
  // start map
  await setMap(em, "obstacles1");

  // once the map is loaded, we can run JFA
  res.renderer.renderer.submitPipelines([], [...mapJfa.allPipes()]);

  // TODO(@darzu): simplify this pattern
  const terraTex = await res.renderer.renderer.readTexture(mapJfa.sdfTex);
  const terraReader = createTextureReader(
    terraTex,
    mapJfa.sdfTex.size,
    1,
    mapJfa.sdfTex.format
  );
  function sampleTerra(worldX: number, worldZ: number) {
    let xi = ((worldZ + WORLD_WIDTH * 0.5) / WORLD_WIDTH) * terraReader.size[0];
    let yi =
      ((worldX + WORLD_HEIGHT * 0.5) / WORLD_HEIGHT) * terraReader.size[1];
    // xi = clamp(xi, 0, terraReader.size[0]);
    // yi = clamp(yi, 0, terraReader.size[1]);
    const height = terraReader.sample(xi, yi) / 256;
    // console.log(`xi: ${xi}, yi: ${yi} => ${height}`);
    return height;
  }

  // height map
  const terraVertsPerWorldUnit = 0.25;
  const worldUnitPerTerraVerts = 1 / terraVertsPerWorldUnit;
  const terraZCount = Math.floor(WORLD_WIDTH * terraVertsPerWorldUnit);
  const terraXCount = Math.floor(WORLD_HEIGHT * terraVertsPerWorldUnit);
  const terraMesh = createFlatQuadMesh(terraZCount, terraXCount);
  // let minY = Infinity;
  terraMesh.pos.forEach((p, i) => {
    // console.log("i: " + vec3Dbg(p));
    const x = p[0] * worldUnitPerTerraVerts - WORLD_HEIGHT * 0.5;
    const z = p[2] * worldUnitPerTerraVerts - WORLD_WIDTH * 0.5;
    let y = sampleTerra(x, z) * 100.0;
    // minY = Math.min(minY, y);

    // TODO(@darzu): wierd hack for shorline:
    if (y <= 1.0) y = -30;

    y += Math.random() * 2.0; // TODO(@darzu): jitter for less uniform look?

    p[0] = x;
    p[1] = y;
    p[2] = z;
    // console.log("o: " + vec3Dbg(p));
    // if (i > 10) throw "stop";
  });
  // console.log(`heightmap minY: ${minY}`);
  const hm = em.new();
  em.ensureComponentOn(hm, RenderableConstructDef, terraMesh);
  em.ensureComponentOn(hm, PositionDef);
  // TODO(@darzu): maybe do a sable-like gradient accross the terrain, based on view dist or just uv?
  // em.ensureComponentOn(hm, ColorDef, V(0.4, 0.2, 0.2));
  em.ensureComponentOn(hm, ColorDef, ENDESGA16.lightGray);
  // TODO(@darzu): update terra from SDF

  // sky dome?
  const SKY_HALFSIZE = 1000;
  const domeMesh = makeDome(16, 8, SKY_HALFSIZE);
  const sky = EM.new();
  em.ensureComponentOn(sky, PositionDef, V(0, -100, 0));
  // const skyMesh = cloneMesh(res.assets.cube.mesh);
  // skyMesh.pos.forEach((p) => vec3.scale(p, SKY_HALFSIZE, p));
  // skyMesh.quad.forEach((f) => vec4.reverse(f, f));
  // skyMesh.tri.forEach((f) => vec3.reverse(f, f));
  const skyMesh = domeMesh;
  em.ensureComponentOn(
    sky,
    RenderableConstructDef,
    skyMesh,
    undefined,
    undefined,
    SKY_MASK
  );
  // em.ensureComponentOn(sky, ColorDef, V(0.9, 0.9, 0.9));

  // ocean
  const oceanVertsPerWorldUnit = 0.25;
  const worldUnitPerOceanVerts = 1 / oceanVertsPerWorldUnit;
  const oceanZCount = Math.floor(WORLD_WIDTH * oceanVertsPerWorldUnit);
  const oceanXCount = Math.floor(WORLD_HEIGHT * oceanVertsPerWorldUnit);
  const oceanMesh = createFlatQuadMesh(oceanZCount, oceanXCount);
  const maxSurfId = max(oceanMesh.surfaceIds);
  console.log("maxSurfId");
  console.log(maxSurfId);
  oceanMesh.pos.forEach((p, i) => {
    const x = p[0] * worldUnitPerOceanVerts - WORLD_HEIGHT * 0.5;
    const z = p[2] * worldUnitPerOceanVerts - WORLD_WIDTH * 0.5;
    const y = 0.0;
    p[0] = x;
    p[1] = y;
    p[2] = z;
  });
  // TODO(@darzu): I don't think the PBR-ness of this color is right
  // initOcean(oceanMesh, V(0.1, 0.3, 0.8));
  initOcean(oceanMesh, ENDESGA16.blue);
  await em.whenResources(OceanDef); // TODO(@darzu): need to wait?

  em.addResource(WindDef);
  em.requireSystem("changeWind");
  em.requireSystem("smoothWind");

  // load level
  const level = await EM.whenResources(LevelMapDef);

  const ship = await createShip(em);
  // move down
  // ship.position[2] = -WORLD_SIZE * 0.5 * 0.6;
  level2DtoWorld3D(level.levelMap.startPos, 15, ship.position);
  // vec3.copy(ship.position, SHIP_START_POS);
  em.requireSystem("sailShip");
  em.requireSystem("shipParty");

  // bouyancy
  // const bouy = em.new();
  // em.ensureComponentOn(bouy, PositionDef);
  // em.ensureComponentOn(bouy, ScaleDef, V(5, 5, 5));
  // em.ensureComponentOn(bouy, RenderableConstructDef, res.assets.ball.proto);
  // em.ensureComponentOn(bouy, ColorDef, ENDESGA16.lightGreen);
  // em.registerSystem(
  //   [ShipDef],
  //   [OceanDef],
  //   (ships, res) => {
  //     // TODO(@darzu): unify with UV ship stuff?
  //     if (!ships.length) return;
  //     const [ship] = ships;
  //     const { ocean } = res;

  //     const uv = V(0.5, 0.5);
  //     let pos = vec3.tmp();
  //     ocean.uvToPos(pos, uv);
  //     let disp = vec3.tmp();
  //     let norm = vec3.tmp();
  //     ocean.uvToGerstnerDispAndNorm(disp, norm, uv);
  //     vec3.add(pos, disp, bouy.position);
  //     // console.log(vec3Dbg(bouy.position));
  //   },
  //   "shipBouyancy"
  // );
  // em.requireSystem("shipBouyancy");

  // player
  if (!DBG_PLAYER) {
    const player = await createPlayer();
    player.physicsParent.id = ship.id;
    // vec3.set(0, 3, -1, player.position);
    const rudder = ship.ld52ship.rudder()!;
    vec3.copy(player.position, rudder.position);
    player.position[1] = 1.45;
    assert(CameraFollowDef.isOn(rudder));
    raiseManTurret(player, rudder);
  }

  if (DBG_PLAYER) {
    const g = createGhost();
    // vec3.copy(g.position, [0, 1, -1.2]);
    // quat.setAxisAngle([0.0, -1.0, 0.0], 1.62, g.rotation);
    // g.cameraFollow.positionOffset = V(0, 0, 5);
    g.controllable.speed *= 2.0;
    g.controllable.sprintMul = 15;
    const sphereMesh = cloneMesh(res.assets.ball.mesh);
    const visible = false;
    em.ensureComponentOn(g, RenderableConstructDef, sphereMesh, visible);
    em.ensureComponentOn(g, ColorDef, V(0.1, 0.1, 0.1));
    // em.ensureComponentOn(g, PositionDef, V(0, 0, 0));
    // em.ensureComponentOn(b2, PositionDef, [0, 0, -1.2]);
    em.ensureComponentOn(g, WorldFrameDef);
    // em.ensureComponentOn(b2, PhysicsParentDef, g.id);
    em.ensureComponentOn(g, ColliderDef, {
      shape: "AABB",
      solid: false,
      aabb: res.assets.ball.aabb,
    });

    // high up:
    vec3.copy(g.position, [-140.25, 226.5, -366.78]);
    quat.copy(g.rotation, [0.0, -0.99, 0.0, 0.15]);
    vec3.copy(g.cameraFollow.positionOffset, [0.0, 0.0, 5.0]);
    g.cameraFollow.yawOffset = 0.0;
    g.cameraFollow.pitchOffset = -1.009;

    em.registerSystem(
      [GhostDef, WorldFrameDef, ColliderDef],
      [InputsDef, CanvasDef],
      async (ps, { inputs, htmlCanvas }) => {
        if (!ps.length) return;

        const ghost = ps[0];

        if (!htmlCanvas.hasFirstInteraction) return;
      },
      "smolGhost"
    );
    EM.requireGameplaySystem("smolGhost");
  }

  score.onLevelEnd.push(() => {
    // worldCutData.fill(0.0);
    // grassCutTex.queueUpdate(worldCutData);
    // vec3.set(0, 0, 0, ship.position);
    // vec3.copy(ship.position, SHIP_START_POS);
    level2DtoWorld3D(level.levelMap.startPos, 2, ship.position);
    quat.identity(ship.rotation);
    vec3.set(0, 0, 0, ship.linearVelocity);
    const sail = ship.ld52ship.mast()!.mast.sail()!.sail;
    sail.unfurledAmount = sail.minFurl;
    ship.ld52ship.cuttingEnabled = true;
    ship.ld52ship.rudder()!.yawpitch.yaw = 0;
  });

  EM.registerSystem(
    [],
    [InputsDef],
    (_, res) => {
      const mast = ship.ld52ship.mast()!;
      const rudder = ship.ld52ship.rudder()!;

      // furl/unfurl
      if (rudder.turret.mannedId) {
        const sail = mast.mast.sail()!.sail;
        if (res.inputs.keyDowns["w"]) sail.unfurledAmount += SAIL_FURL_RATE;
        if (res.inputs.keyDowns["s"]) sail.unfurledAmount -= SAIL_FURL_RATE;
        sail.unfurledAmount = clamp(sail.unfurledAmount, sail.minFurl, 1.0);
      }
    },
    "furlUnfurl"
  );
  EM.requireSystem("furlUnfurl");

  const shipWorld = await EM.whenEntityHas(ship, WorldFrameDef);

  EM.registerSystem(
    [],
    [InputsDef, WindDef],
    (_, res) => {
      const mast = ship.ld52ship.mast()!;
      // const rudder = ship.ld52ship.rudder()!;

      // const shipDir = vec3.transformQuat(V(0, 0, 1), shipWorld.world.rotation);

      const invShip = mat3.invert(mat3.fromMat4(shipWorld.world.transform));
      const windLocalDir = vec3.transformMat3(res.wind.dir, invShip);
      const shipLocalDir = V(0, 0, 1);

      const optimalSailLocalDir = vec3.normalize(
        vec3.add(windLocalDir, shipLocalDir)
      );

      // console.log(`ship to wind: ${vec3.dot(windLocalDir, shipLocalDir)}`);

      // const normal = vec3.transformQuat(AHEAD_DIR, e.world.rotation);
      // e.sail.billowAmount = vec3.dot(normal, res.wind.dir);
      // sail.force * vec3.dot(AHEAD_DIR, normal);

      // const currSailForce =

      // need to maximize: dot(wind, sail) * dot(sail, ship)

      // TODO(@darzu): ANIMATE SAIL TOWARD WIND
      if (vec3.dot(optimalSailLocalDir, shipLocalDir) > 0.01)
        quatFromUpForward(mast.rotation, V(0, 1, 0), optimalSailLocalDir);
    },
    "turnMast"
  );
  EM.requireSystem("turnMast");

  const { text } = await EM.whenResources(TextDef);
  text.lowerText =
    "W/S: unfurl/furl, A/D: turn, SPACE: harvest on/off, E: use/unuse rudder";
  if (DBG_PLAYER) text.lowerText = "";

  // Spawn towers
  {
    const tower3DPoses = level.levelMap.towers.map((tPos) =>
      level2DtoWorld3D(
        tPos,
        20, // TODO(@darzu): lookup from heightmap?
        vec3.create()
      )
    );
    await startTowers(tower3DPoses);
  }

  // world gizmo
  const worldGizmo = EM.new();
  EM.ensureComponentOn(
    worldGizmo,
    PositionDef,
    V(-WORLD_HEIGHT / 2, 0, -WORLD_WIDTH / 2)
  );
  EM.ensureComponentOn(worldGizmo, ScaleDef, V(100, 100, 100));
  EM.ensureComponentOn(
    worldGizmo,
    RenderableConstructDef,
    res.assets.gizmo.proto
  );

  // debugging createGraph3D
  let data: vec3[][] = [];
  for (let x = 0; x < 12; x++) {
    data[x] = [];
    for (let z = 0; z < 7; z++) {
      data[x][z] = V(x, x + z, z);
    }
  }
  createGraph3D(vec3.add(worldGizmo.position, [50, 10, 50], V(0, 0, 0)), data);
  let stoneTower = EM.new();
  EM.ensureComponentOn(stoneTower, PositionDef, V(0, 20, 0));
  EM.ensureComponentOn(
    stoneTower,
    RenderableConstructDef,
    createStoneTower(20, 100, 10, 5, 10, true)
  );
  EM.ensureComponentOn(stoneTower, ColorDef, ENDESGA16.lightGray);
}

async function createPlayer() {
  const { assets, me } = await EM.whenResources(AssetsDef, MeDef);
  const p = EM.new();
  EM.ensureComponentOn(p, ControllableDef);
  p.controllable.modes.canFall = false;
  p.controllable.modes.canJump = false;
  // g.controllable.modes.canYaw = true;
  // g.controllable.modes.canPitch = true;
  EM.ensureComponentOn(p, CameraFollowDef, 1);
  // setCameraFollowPosition(p, "firstPerson");
  // setCameraFollowPosition(p, "thirdPerson");
  EM.ensureComponentOn(p, PositionDef);
  EM.ensureComponentOn(p, RotationDef);
  // quat.rotateY(g.rotation, quat.IDENTITY, (-5 * Math.PI) / 8);
  // quat.rotateX(g.cameraFollow.rotationOffset, quat.IDENTITY, -Math.PI / 8);
  EM.ensureComponentOn(p, LinearVelocityDef);

  vec3.copy(p.position, [0, 1, -1.2]);
  quat.setAxisAngle([0.0, -1.0, 0.0], 1.62, p.rotation);
  p.cameraFollow.positionOffset = V(0, 0, 5);
  p.controllable.speed *= 0.5;
  p.controllable.sprintMul = 10;
  const sphereMesh = cloneMesh(assets.ball.mesh);
  const visible = true;
  EM.ensureComponentOn(p, RenderableConstructDef, sphereMesh, visible);
  EM.ensureComponentOn(p, ColorDef, V(0.1, 0.1, 0.1));
  EM.ensureComponentOn(p, PositionDef, V(0, 0, 0));
  // em.ensureComponentOn(b2, PositionDef, [0, 0, -1.2]);
  EM.ensureComponentOn(p, WorldFrameDef);
  // em.ensureComponentOn(b2, PhysicsParentDef, g.id);
  EM.ensureComponentOn(p, ColliderDef, {
    shape: "AABB",
    solid: true,
    aabb: assets.ball.aabb,
  });

  vec3.copy(p.position, [-28.11, 26.0, -28.39]);
  quat.copy(p.rotation, [0.0, -0.94, 0.0, 0.34]);
  vec3.copy(p.cameraFollow.positionOffset, [0.0, 2.0, 5.0]);
  p.cameraFollow.yawOffset = 0.0;
  p.cameraFollow.pitchOffset = -0.593;

  EM.ensureResource(LocalPlayerDef, p.id);
  EM.ensureComponentOn(p, PlayerDef);
  EM.ensureComponentOn(p, AuthorityDef, me.pid);
  EM.ensureComponentOn(p, PhysicsParentDef);
  return p;
}
