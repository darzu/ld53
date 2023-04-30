import { EM } from "../entity-manager.js";
import { PartyDef } from "../games/party.js";
import { TextDef } from "../games/ui.js";
import { ShipHealthDef } from "../ld53/ship-health.js";
import { createAABB, pointInAABB } from "../physics/aabb.js";
import { TimeDef } from "../time.js";
import { setMap } from "./level-map.js";
import { MapPaths } from "./map-loader.js";
import { ShipDef } from "./ship.js";

export const ScoreDef = EM.defineComponent("score", () => ({
  cutPurple: 0,
  totalPurple: 0,
  completedLevels: 0,
  levelNumber: 0,
  gameEnding: false,
  gameEndedAt: 0,
  levelEnding: false,
  levelEndedAt: 0,
  victory: false,
  endZoneAABB: createAABB(),
  // TODO: this is very hacky
  onLevelEnd: [] as (() => void)[],
  onGameEnd: [] as (() => void)[],
}));

EM.registerSystem(
  [ShipHealthDef],
  [ScoreDef, TextDef],
  (es, res) => {
    const ship = es[0];
    if (!ship) return;
    if (!res.score.gameEnding && !res.score.levelEnding) {
      // TODO(@darzu): re-IMPL
      res.text.upperText = `health: ${(ship.shipHealth.health * 100).toFixed(
        0
      )}`;
    }
  },
  "updateScoreDisplay"
);

EM.registerSystem(
  [ShipHealthDef],
  [ScoreDef, TextDef, TimeDef, PartyDef],
  (es, res) => {
    const ship = es[0];
    if (!ship) return;
    if (res.score.gameEnding) {
      if (res.time.step > res.score.gameEndedAt + 300) {
        res.score.gameEnding = false;
        if (res.score.victory) {
          res.score.levelNumber = 0;
          res.score.victory = false;
        }
        setMap(EM, MapPaths[res.score.levelNumber]);
        //res.score.shipHealth = 10000;
        for (let f of res.score.onLevelEnd) {
          f();
        }
        for (let f of res.score.onGameEnd) {
          f();
        }
      }
    } else if (res.score.levelEnding) {
      if (res.time.step > res.score.levelEndedAt + 300) {
        res.score.levelEnding = false;
        res.score.completedLevels++;
        res.score.levelNumber++;
        setMap(EM, MapPaths[res.score.levelNumber]);
        //res.score.shipHealth = 10000;
        for (let f of res.score.onLevelEnd) {
          f();
        }
      }
    } else if (ship.shipHealth.health <= 0) {
      // END GAME
      res.score.gameEnding = true;
      res.score.gameEndedAt = res.time.step;
      res.text.upperText = "LEVEL FAILED";
    } else if (pointInAABB(res.score.endZoneAABB, res.party.pos)) {
      console.log("res.score.levelNumber: " + res.score.levelNumber);
      console.log("MapPaths.length: " + MapPaths.length);
      if (res.score.levelNumber + 1 >= MapPaths.length) {
        res.score.gameEnding = true;
        res.score.gameEndedAt = res.time.step;
        res.score.victory = true;
        res.text.upperText = "YOU WIN";
      } else {
        res.score.levelEnding = true;
        res.score.levelEndedAt = res.time.step;
        res.text.upperText = "LEVEL COMPLETE";
      }
    }
  },
  "detectGameEnd"
);
