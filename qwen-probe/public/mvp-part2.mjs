// Original practice prompts, written for this app; these are not official exam questions.
export const TOPICS = Object.freeze([
  { id: 'place-to-reset', category: '地点', title: 'A place where you reset', prompt: 'Describe a place you go to when you need a fresh start.', bullets: ['Where the place is', 'What you usually do there', 'When you last went there', 'Why it helps you feel different'] },
  { id: 'unexpected-skill', category: '经历', title: 'An unexpected skill', prompt: 'Describe a skill you learned when you were trying to do something else.', bullets: ['What you were originally trying to do', 'What you learned along the way', 'Who or what helped you', 'How you use the skill now'] },
  { id: 'small-help', category: '人物', title: 'Someone who made things easier', prompt: 'Describe a person who helped you with a small but meaningful problem.', bullets: ['Who the person is', 'What the problem was', 'How the person helped', 'Why you still remember the help'] },
  { id: 'useful-object', category: '物品', title: 'An ordinary object you value', prompt: 'Describe an everyday object that has become more useful than you expected.', bullets: ['What the object is', 'How you got it', 'What you use it for', 'Why you would miss it'] },
  { id: 'changed-routine', category: '生活', title: 'A routine you changed', prompt: 'Describe a daily routine you changed after noticing a problem.', bullets: ['What your old routine was', 'What made you reconsider it', 'What you changed', 'How the change affected your day'] },
  { id: 'shared-meal', category: '经历', title: 'A meal that started a conversation', prompt: 'Describe a meal during which you had an interesting conversation.', bullets: ['Where and when the meal happened', 'Who you were with', 'What you talked about', 'Why the conversation mattered to you'] },
  { id: 'local-detail', category: '地点', title: 'A detail in your neighbourhood', prompt: 'Describe a small feature of your neighbourhood that visitors might overlook.', bullets: ['What the feature is', 'Where people can find it', 'How you noticed it', 'What it tells you about the area'] },
  { id: 'recommendation-tried', category: '媒体', title: 'A recommendation you tried', prompt: 'Describe something you tried because someone recommended it.', bullets: ['What was recommended', 'Who recommended it and why', 'What your experience was like', 'Whether you would recommend it to others'] },
  { id: 'plan-changed', category: '经历', title: 'A plan you adapted', prompt: 'Describe an occasion when you had to change a plan at short notice.', bullets: ['What you had planned', 'What happened unexpectedly', 'What you decided to do instead', 'What you learned from the experience'] },
  { id: 'question-worth-asking', category: '学习', title: 'A question worth asking', prompt: 'Describe a question that helped you understand something better.', bullets: ['What you were trying to understand', 'What question you asked', 'How you found an answer', 'Why asking the question was helpful'] },
  { id: 'creative-solution', category: '工作', title: 'A simple creative solution', prompt: 'Describe a simple solution you found to a practical problem.', bullets: ['What needed to be solved', 'What resources you had', 'How you came up with the solution', 'How well it worked'] },
  { id: 'time-well-spent', category: '生活', title: 'An hour well spent', prompt: 'Describe an occasion when you were pleased with how you spent a free hour.', bullets: ['When you had the free time', 'What you chose to do', 'Why you chose that activity', 'How you felt afterwards'] },
].map(topic => Object.freeze({ ...topic, bullets: Object.freeze(topic.bullets) })));

export function createPart2Clock({ now = () => performance.now() } = {}) {
  let phase = 'idle', deadline = 0;
  const tick = () => ({ phase, remainingMs: ['preparing', 'answering'].includes(phase) ? Math.max(0, deadline - now()) : 0 });
  return {
    prepare() { if (phase !== 'preparing') { phase = 'preparing'; deadline = now() + 60_000; } return tick(); },
    answer() { if (phase !== 'answering') { phase = 'answering'; deadline = now() + 120_000; } return tick(); },
    finish() { phase = 'finished'; deadline = 0; return tick(); },
    tick,
  };
}
