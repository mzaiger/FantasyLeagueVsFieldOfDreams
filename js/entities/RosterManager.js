/* =====================================================================
   RosterManager.js — club selection, roster randomisation, lineups
   Part of the Lincoln Red Gauntlet engine · js/entities/
===================================================================== */
import { NAMES, POSITIONS } from '../core/Constants.js';
import { shuffle } from '../utils/MathUtils.js';

/* Visiting club — FIXED, not drawn: every game is the titled matchup
   "Lincoln Fantasy League vs Field of Dreams" (user directive). The deep
   corn-green primary deliberately fails HUDController/Scoreboard's
   redLikeLin() test, so it renders verbatim and never swaps to a fallback. */
export const OPP = { city:'Field of', nick:'Dreams', abbr:'FOD', pri:'#2F5D3A', sec:'#f5f0dc' };

/* The Dreams' eleven — verbatim from the user's roster sheet. Insertion
   order doubles as the defensive sheet; Game.js builds the batting order by
   filtering out Pitcher & Manager, so Catcher leads off and the DH bats
   ninth. Ty Cobb never takes the field (visitorNine has no DH slot — every
   visitorNine lookup guards him away); John Kinsella is dugout-only. */
export const oppFielders = {
  'Pitcher':'Eddie Cicotte','Catcher':'Swede Risberg','1st Base':'Chick Gandil',
  '2nd Base':'Gil Hodges','3rd Base':'Buck Weaver','Shortstop':'Smoky Joe Wood',
  'Left Field':'"Shoeless" Joe Jackson','Center Field':'Mel Ott',
  'Right Field':'Archie "Moonlight" Graham',
  'Designated Hitter':'Ty Cobb','Manager':'John Kinsella'
};

/* The nine who take the field — drawer + any future UI iterate THIS, never
   Object.keys(oppFielders), so DH/skipper stay out of the defense list. */
export const OPP_DEF_KEYS = ['Pitcher','Catcher','1st Base','2nd Base','3rd Base','Shortstop',
  'Left Field','Center Field','Right Field'];

export const OPP_PITCHER_NAME = oppFielders['Pitcher'];

/* Home nine: shuffle the 11 names across all 11 positions every load */
const bag = shuffle([...NAMES]);
export const roster = {};
POSITIONS.forEach((p, i) => roster[p] = bag[i]);

/* Batting order — every position except Pitcher & Manager */
export const lineupOrder = shuffle(POSITIONS.filter(p => p !== 'Pitcher' && p !== 'Manager'));
export const LINEUP_LEN = lineupOrder.length;
