/* =====================================================================
   GameState.js — single source of truth for the game state machine
   BOOT → READY → WINDUP → PITCH → LIVE | DEAD → OVER
   Part of the Lincoln Red Gauntlet engine · js/core/
===================================================================== */
import { FINAL_INNINGS } from './Constants.js';

export const G = {
  state:'BOOT',
  inning:1, half:'bottom',          // Lincoln always bats in the bottom half
  balls:0, strikes:0, outs:0,
  score:{ lin:0, opp:0 },
  bases:[false, false, false],      // 1B, 2B, 3B occupied?
  batterIdx:0,
  paDone:false,
  hrConfirmed:false,
  pitch:null,                       // active pitch descriptor
  swungAt:null,                     // swing timestamp
  result:null                       // classified outcome of a batted ball
};
