import { Mesh } from "../render/mesh.js";
import { mat4, tV, V, vec3 } from "../sprig-matrix.js";

export function createStoneTower(
  rows: number,
  radius: number,
  brickWidth: number,
  brickHeight: number,
  brickDepth: number,
  coolMode: boolean
): Mesh {
  const mesh: Mesh = {
    pos: [],
    colors: [],
    quad: [],
    tri: [],
    surfaceIds: [],
    usesProvoking: true,
    dbgName: "tower",
  };

  const n = Math.floor(Math.PI / Math.asin(brickWidth / (2 * radius)));

  brickWidth = radius * 2 * Math.sin(Math.PI / n);
  console.log(`n = ${n}, w = ${brickWidth}`);

  const cursor = mat4.create();
  function applyCursor(v: vec3): vec3 {
    return vec3.transformMat4(v, cursor, v);
  }
  function appendBrick() {
    const index = mesh.pos.length;
    // base
    mesh.pos.push(applyCursor(V(0, 0, 0)));
    mesh.pos.push(applyCursor(V(0 + brickWidth, 0, 0)));
    mesh.pos.push(applyCursor(V(0, 0, 0 + brickDepth)));
    mesh.pos.push(applyCursor(V(0 + brickWidth, 0, 0 + brickDepth)));

    //top
    mesh.pos.push(applyCursor(V(0, 0 + brickHeight, 0)));
    mesh.pos.push(applyCursor(V(0 + brickWidth, 0 + brickHeight, 0)));
    mesh.pos.push(applyCursor(V(0, 0 + brickHeight, 0 + brickDepth)));
    mesh.pos.push(
      applyCursor(V(0 + brickWidth, 0 + brickHeight, 0 + brickDepth))
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
  }

  let angle = (2 * Math.PI) / n;
  for (let r = 0; r < rows; r++) {
    mat4.identity(cursor);
    mat4.translate(cursor, [0, r * brickHeight, 0], cursor);
    mat4.rotateY(cursor, Math.random() * 2 * Math.PI, cursor);
    mat4.translate(cursor, [0, 0, radius], cursor);
    mat4.rotateY(cursor, coolMode ? -angle / 2 : angle / 2, cursor);
    for (let i = 0; i < n; i++) {
      appendBrick();
      if (coolMode) {
        mat4.rotateY(cursor, angle, cursor);
        mat4.translate(cursor, [brickWidth, 0, 0], cursor);
      } else {
        mat4.translate(cursor, [brickWidth, 0, 0], cursor);
        mat4.rotateY(cursor, angle, cursor);
      }
    }
  }
  mesh.quad.forEach(() => mesh.colors.push(V(0, 0, 0)));
  mesh.quad.forEach((_, i) => mesh.surfaceIds.push(i + 1));
  return mesh;
}
