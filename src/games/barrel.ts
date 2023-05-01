import { getHalfsizeFromAABB } from "../physics/aabb.js";
import { Mesh, getAABBFromMesh, validateMesh } from "../render/mesh.js";
import { V, quat, vec3 } from "../sprig-matrix.js";
import {
  WoodState,
  createEmptyMesh,
  TimberBuilder,
  createTimberBuilder,
  getBoardsFromMesh,
  verifyUnsharedProvokingForWood,
  reserveSplinterSpace,
} from "../wood.js";
import { lerpBetween, Path, appendBoard } from "./shipyard.js";

export function createBarrelMesh(): [Mesh, WoodState] {
  // TODO(@darzu): IMPL

  const _timberMesh = createEmptyMesh("barrel");

  const builder: TimberBuilder = createTimberBuilder(_timberMesh);

  const numPlanks = 16;
  const plankWidth = 2.0;
  const plankDepth = 0.8;
  const plankGap = 0.05;
  const plankLength = 60;
  const segLen = 20 / 6;
  const plankSegNum = plankLength / segLen;
  for (let i = 0; i < numPlanks; i++) {
    const x = plankWidth * i;
    const start = V(x, 0, 0);
    const end = V(x, 0, plankLength);

    const positions = lerpBetween(start, end, plankSegNum - 2);

    const path: Path = positions.map((pos) => ({
      pos,
      rot: quat.fromEuler(Math.PI / 2, 0, 0, quat.create()),
    }));

    // dbgPathWithGizmos(path);

    appendBoard(builder.mesh, {
      path: path,
      width: plankWidth / 2 - plankGap,
      depth: plankDepth / 2,
    });
  }

  // recenter
  const size = getHalfsizeFromAABB(getAABBFromMesh(_timberMesh));
  _timberMesh.pos.forEach((v) => vec3.sub(v, size, v));

  _timberMesh.surfaceIds = _timberMesh.colors.map((_, i) => i);
  const timberState = getBoardsFromMesh(_timberMesh);
  verifyUnsharedProvokingForWood(_timberMesh, timberState);
  const timberMesh = _timberMesh as Mesh;
  timberMesh.usesProvoking = true;

  reserveSplinterSpace(timberState, 200);
  validateMesh(timberState.mesh);

  return [timberMesh, timberState];
}
