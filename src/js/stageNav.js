import { getGroupOrder, MAX_RANK } from './bracketData.js';

/**
 * Final-week mode: only the Official / Final Round stage is usable.
 * Group Stage, Third Place, and personal Knockout stay in the DOM but are
 * disabled so we don't break Official Bracket wiring or persistence.
 */
export const OFFICIAL_ONLY_MODE = true;

export const STAGE_HEADER_LABELS = {
  groups: 'Group Stage',
  third: 'Third Place',
  knockout: 'Knockout',
  officialBracket: 'The Final Round',
};

export const STAGE_HEADER_TAGLINES = {
  groups:
    'Rank all twelve groups, then play through third place and the knockout — screenshot when you are happy with your bracket.',
  third:
    'Pick the eight third-place teams you think advance to the Round of 32.',
  knockout:
    'Click through the knockout tree to your champion, then screenshot your bracket.',
  officialBracket:
    'Spain vs Argentina in the Final. Pick the champion and the third-place match, then screenshot your picks.',
};

/** OG-strict: every group must have all four ranks before Third Place unlocks. */
export function allGroupsRanked(picks = {}) {
  return getGroupOrder().every((code) => (picks[code]?.length || 0) >= MAX_RANK);
}

export function isThirdPlaceComplete(thirdGroups = []) {
  return thirdGroups.length === 8;
}

export function getStageNavState(picks, thirdGroups, activeStage) {
  if (OFFICIAL_ONLY_MODE) {
    return {
      groups: {
        active: false,
        completed: allGroupsRanked(picks),
        disabled: true,
        hidden: true,
      },
      third: {
        active: false,
        completed: isThirdPlaceComplete(thirdGroups),
        disabled: true,
        hidden: true,
      },
      knockout: {
        active: false,
        completed: false,
        disabled: true,
        hidden: true,
      },
      officialBracket: {
        active: true,
        completed: false,
        disabled: false,
        hidden: false,
      },
    };
  }

  const groupsComplete = allGroupsRanked(picks);
  const thirdComplete = isThirdPlaceComplete(thirdGroups);
  return {
    groups: { active: activeStage === 'groups', completed: groupsComplete, hidden: false },
    third: {
      active: activeStage === 'third',
      completed: thirdComplete,
      disabled: !groupsComplete,
      hidden: false,
    },
    knockout: {
      active: activeStage === 'knockout',
      completed: false,
      disabled: !thirdComplete,
      hidden: false,
    },
    officialBracket: {
      active: activeStage === 'officialBracket',
      completed: false,
      disabled: false,
      hidden: false,
    },
  };
}
