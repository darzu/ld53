// Import .obj files into sprig format
// https://people.cs.clemson.edu/~dhouse/courses/405/docs/brief-obj-file-format.html

import { vec3 } from "./gl-matrix.js";
import { Mesh } from "./mesh-pool.js";
import { assert } from "./test.js";
import { isString } from "./util.js";

/*
Notes:
 - .obj is ascii
 - .mtl file is a materials file

format:
v x y z <- geo vertex
vn vi dx dy dz <- normal
vt vi u v <- texture vertex
f v1/t1/n1 v2/t2/n2 .... vn/tn/nn <- face
usemtl NAME <- starting a material
*/

export type ParseError = string; // TODO(@darzu): more sophisticated error format?

export function isParseError(m: any | ParseError): m is ParseError {
  return isString(m);
}

// TODO(@darzu): can we do cool tuple typing generic sh*t here?
export function parseVec(p: string[], len: number): number[] | ParseError {
  const nums = p.map((s) => parseFloat(s));
  if (nums.some((n) => isNaN(n) || !isFinite(n)))
    return `invalid vector-${len} format: ${p.join(" ")}`;
  if (nums.length !== len)
    return `invalid vector-${len} format: ${p.join(" ")}`;
  return nums;
}

export function importObj(obj: string): Mesh | ParseError {
  // TODO(@darzu): implement a streaming parser for better perf
  const pos: vec3[] = [];
  const tri: vec3[] = [];
  const colors: vec3[] = [];

  const lns = obj.split("\n");
  for (let l of lns) {
    const [kind, ...p] = l.split(" ");
    if (!kind) {
      continue;
    } else if (kind === "v") {
      // parse vertex
      const nums = parseVec(p, 3);
      if (isParseError(nums)) return nums;
      pos.push(nums as vec3);
    } else if (kind === "vn") {
      // parse normal
    } else if (kind === "usemtl") {
      // parse material assignment
    } else if (kind === "f") {
      // parse face
    } else if (
      kind === "#" || // comment
      kind === "mtllib" || // accompanying .mtl file name
      kind === "o" || // object name
      kind === "vt" || // texture coordinate
      kind === "s" || // TODO(@darzu): What does "s" mean?
      false
    ) {
      // ignore it
    } else {
      console.warn(`unknown .obj line format:\n${l}`);
    }
  }

  if (!pos.length) return "empty mesh";

  return { pos, tri, colors };
}

// TESTS

function assertObjError(obj: string, e: ParseError): void {
  const m = importObj(obj);
  assert(
    isString(m) && m === e,
    `error mismatch, actual: ${m} vs expected: ${e}`
  );
}
function assertObjSuccess(obj: string): Mesh {
  const m = importObj(obj);
  assert(!isParseError(m), `failed to import obj: ${m}`);
  return m;
}

export function testImporters() {
  // invalid
  assertObjError("oijawlidjoiwad", "empty mesh");
  assertObjError("", "empty mesh");
  assertObjError("v foo bar", "invalid vector-3 format: foo bar");
  assertObjError("v 1 2 3 4", "invalid vector-3 format: 1 2 3 4");

  // valid
  assertObjSuccess("v 0 1 2");

  // valid, complex
  const hat = assertObjSuccess(HAT_OBJ);
  console.dir(hat);
}

// Example hat, straight from blender:
const HAT_OBJ = `
# Blender v2.92.0 OBJ File: 'hat.blend'
# www.blender.org
mtllib hat.mtl
o Cylinder
v 0.000000 0.000000 -1.000000
v -0.000000 0.100000 -0.956888
v 0.707107 0.000000 -0.707107
v 0.676622 0.100000 -0.676622
v 1.000000 0.000000 0.000000
v 0.956888 0.100000 0.000000
v 0.707107 0.000000 0.707107
v 0.676622 0.100000 0.676622
v -0.000000 0.000000 1.000000
v -0.000000 0.100000 0.956888
v -0.707107 0.000000 0.707107
v -0.676622 0.100000 0.676622
v -1.000000 0.000000 -0.000000
v -0.956888 0.100000 -0.000000
v -0.707107 0.000000 -0.707107
v -0.676622 0.100000 -0.676622
v -0.000000 0.100000 -0.462975
v 0.327373 0.100000 -0.327373
v 0.462975 0.100000 0.000000
v 0.327373 0.100000 0.327373
v -0.000000 0.100000 0.462975
v -0.327373 0.100000 0.327373
v -0.462975 0.100000 -0.000000
v -0.327373 0.100000 -0.327373
v -0.000000 0.405509 -0.382035
v 0.270140 0.405509 -0.270140
v 0.382035 0.405509 0.000000
v 0.270140 0.405509 0.270140
v -0.000000 0.405509 0.382035
v -0.270140 0.405509 0.270140
v -0.382035 0.405509 -0.000000
v -0.270140 0.405509 -0.270140
v -0.000000 0.463052 -0.000000
vt 1.000000 0.500000
vt 1.000000 1.000000
vt 0.875000 1.000000
vt 0.875000 0.500000
vt 0.750000 1.000000
vt 0.750000 0.500000
vt 0.625000 1.000000
vt 0.625000 0.500000
vt 0.500000 1.000000
vt 0.500000 0.500000
vt 0.375000 1.000000
vt 0.375000 0.500000
vt 0.250000 1.000000
vt 0.250000 0.500000
vt 0.375000 1.000000
vt 0.250000 1.000000
vt 0.250000 1.000000
vt 0.375000 1.000000
vt 0.125000 1.000000
vt 0.125000 0.500000
vt 0.000000 1.000000
vt 0.000000 0.500000
vt 0.919706 0.080294
vt 0.580294 0.080294
vt 0.580294 0.419706
vt 0.750000 1.000000
vt 0.875000 1.000000
vt 0.500000 1.000000
vt 0.250000 0.490000
vt 0.080294 0.419706
vt 0.080294 0.419706
vt 0.250000 0.490000
vt 1.000000 1.000000
vt 0.625000 1.000000
vt 0.010000 0.250000
vt 0.010000 0.250000
vt 0.500000 1.000000
vt 0.625000 1.000000
vt 0.750000 1.000000
vt 0.875000 1.000000
vt 0.010000 0.250000
vt 0.080294 0.419706
vt 1.000000 1.000000
vt 0.250000 0.490000
vt 1.000000 1.000000
vt 0.250000 0.490000
vt 0.375000 1.000000
vt 0.625000 1.000000
vt 0.875000 1.000000
vt 0.080294 0.419706
vt 0.500000 1.000000
vt 0.750000 1.000000
vt 0.750000 0.490000
vt 0.919706 0.419706
vt 0.990000 0.250000
vt 0.750000 0.010000
vt 0.510000 0.250000
vn 0.3555 0.3700 -0.8583
vn 0.8583 0.3700 -0.3555
vn 0.8583 0.3700 0.3555
vn 0.3555 0.3700 0.8583
vn -0.3555 0.3700 0.8583
vn -0.8583 0.3700 0.3555
vn 0.8974 -0.2378 -0.3717
vn -0.8583 0.3700 -0.3555
vn -0.3555 0.3700 -0.8583
vn 0.0000 -1.0000 0.0000
vn -0.0000 1.0000 -0.0000
vn -0.3717 -0.2378 -0.8974
vn -0.8974 -0.2378 0.3717
vn -0.8974 0.2378 -0.3717
vn 0.3717 -0.2378 -0.8974
vn -0.8974 -0.2378 -0.3717
vn -0.3717 -0.2378 0.8974
vn -0.3717 0.2378 -0.8974
vn -0.0616 -0.9870 0.1487
vn -0.0616 0.9870 -0.1487
vn 0.1487 -0.9870 -0.0616
vn -0.0616 -0.9870 -0.1487
vn -0.1487 -0.9870 0.0616
vn -0.1487 0.9870 -0.0616
vn 0.0616 -0.9870 -0.1487
vn -0.1487 -0.9870 -0.0616
usemtl None
s off
f 1/1/1 2/2/1 4/3/1 3/4/1
f 3/4/2 4/3/2 6/5/2 5/6/2
f 5/6/3 6/5/3 8/7/3 7/8/3
f 7/8/4 8/7/4 10/9/4 9/10/4
f 9/10/5 10/9/5 12/11/5 11/12/5
f 11/12/6 12/11/6 14/13/6 13/14/6
f 22/15/7 23/16/7 31/17/7 30/18/7
f 13/14/8 14/13/8 16/19/8 15/20/8
f 15/20/9 16/19/9 2/21/9 1/22/9
f 7/23/10 11/24/10 15/25/10
f 4/3/10 6/5/10 19/26/10 18/27/10
f 10/9/10 12/11/10 22/15/10 21/28/10
f 2/29/11 16/30/11 24/31/11 17/32/11
f 2/2/10 4/3/10 18/27/10 17/33/10
f 6/5/10 8/7/10 20/34/10 19/26/10
f 12/11/10 14/13/10 23/16/10 22/15/10
f 8/7/10 10/9/10 21/28/10 20/34/10
f 16/30/11 14/35/11 23/36/11 24/31/11
f 20/34/12 21/28/12 29/37/12 28/38/12
f 18/27/13 19/26/13 27/39/13 26/40/13
f 24/31/14 23/36/14 31/41/14 32/42/14
f 21/28/15 22/15/15 30/18/15 29/37/15
f 19/26/16 20/34/16 28/38/16 27/39/16
f 17/33/17 18/27/17 26/40/17 25/43/17
f 17/32/18 24/31/18 32/42/18 25/44/18
f 25/43/19 26/40/19 33/45/19
f 25/44/20 32/42/20 33/46/20
f 30/18/21 31/17/21 33/47/21
f 28/38/22 29/37/22 33/48/22
f 26/40/23 27/39/23 33/49/23
f 32/42/24 31/41/24 33/50/24
f 29/37/25 30/18/25 33/51/25
f 27/39/26 28/38/26 33/52/26
f 15/25/10 1/53/10 3/54/10
f 3/54/10 5/55/10 7/23/10
f 7/23/10 9/56/10 11/24/10
f 11/24/10 13/57/10 15/25/10
f 15/25/10 3/54/10 7/23/10
`;
