import { createClient } from '@supabase/supabase-js';

// --- ENVIRONMENT VARIABLES ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const CHANNEL_USERNAME = process.env.TELEGRAM_CHANNEL_USERNAME;
const CHANNEL_URL = process.env.TELEGRAM_CHANNEL_URL;

const WEBAPP_URL = process.env.WEBAPP_URL;              // registration mini-app
const HELP_URL = process.env.HELP_URL || 'https://t.me/your_help_link';
const TOP10_WEBAPP_URL = process.env.TOP10_WEBAPP_URL || WEBAPP_URL;

// New: Profile editor Web App URL
const PROFILE_WEBAPP_URL = process.env.PROFILE_WEBAPP_URL || process.env.EDIT_WEBAPP_URL || WEBAPP_URL;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Admins (comma-separated Telegram user IDs), e.g. "123,456"
const ADMIN_IDS = (process.env.TELEGRAM_ADMIN_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((n) => Number(n))
  .filter((n) => Number.isFinite(n));

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---- BASIC TELEGRAM HELPERS ----
async function callTelegram(method, params) {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) console.error('Telegram error', method, data);
  return data;
}

function isAdmin(userId) {
  return ADMIN_IDS.includes(Number(userId));
}

// Send or edit a TEXT menu, and return Telegram API response
async function sendOrEditMenu({ chatId, messageId, text, keyboard }) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard },
  };

  if (messageId) {
    return callTelegram('editMessageText', {
      ...payload,
      message_id: messageId,
    });
  }

  return callTelegram('sendMessage', payload);
}

// ---- SUPABASE HELPERS ----
async function isMemberOfChannel(userId) {
  if (!CHANNEL_USERNAME) return true;

  try {
    const res = await fetch(
      `${TELEGRAM_API}/getChatMember?chat_id=${encodeURIComponent(
        CHANNEL_USERNAME
      )}&user_id=${userId}`
    );
    const data = await res.json();
    if (!data.ok) {
      console.error('getChatMember error', data);
      return false;
    }
    const status = data.result.status;
    return (
      status === 'member' ||
      status === 'administrator' ||
      status === 'creator'
    );
  } catch (e) {
    console.error('isMemberOfChannel error', e);
    return false;
  }
}

async function isRegistered(telegramId) {
  const { data, error } = await supabase
    .from('students')
    .select('id, stream, grade, full_name')
    .eq('telegram_id', telegramId)
    .maybeSingle();
  if (error) {
    console.error('isRegistered error', error);
    return null;
  }
  return data;
}

async function getSession(telegramId) {
  const { data, error } = await supabase
    .from('bot_sessions')
    .select('*')
    .eq('telegram_id', telegramId)
    .maybeSingle();
  if (error || !data) {
    return { telegram_id: telegramId, state: 'IDLE', data: {} };
  }
  return data;
}

async function saveSession(session) {
  const { error } = await supabase.from('bot_sessions').upsert({
    telegram_id: session.telegram_id,
    state: session.state,
    data: session.data,
    updated_at: new Date().toISOString(),
  });
  if (error) console.error('saveSession error', error);
}

// ---- REGISTRATION PROMPT (video + caption + buttons) ----
async function sendRegistrationPrompt(chatId) {
  await callTelegram('sendVideo', {
    chat_id: chatId,
    video: 'https://t.me/MyBotDatabase/4',
    caption:
      '👋 Welcome to A/L MCQ Bot.\n\n' +
      'You are *not registered* yet. Please sign up using the Web App.\n\n' +
      '1️⃣ Tap *Register / Login*\n' +
      '2️⃣ Complete the form\n' +
      '3️⃣ Return here and tap *I have registered*.',
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📝 Register / Login', web_app: { url: WEBAPP_URL } }],
        [{ text: '✅ I have registered', callback_data: 'check_registered' }],
      ],
    },
  });
}

// ---- MAIN GATEKEEPER FLOW ----
async function handleStart(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // 1) Force-subscribe to channel
  const member = await isMemberOfChannel(userId);
  if (!member) {
    await callTelegram('sendPhoto', {
      chat_id: chatId,
      photo: 'https://t.me/MyBotDatabase/7',
      caption:
        '📢 Please join our channel before using the A/L MCQ bot.\n\n' +
        'After joining, tap "Done & Start".',
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📲 Join Channel', url: CHANNEL_URL }],
          [{ text: '✅ Done & Start', callback_data: 'done_join' }],
        ],
      },
    });
    return;
  }

  // 2) Registration check
  const studentRow = await isRegistered(userId);
  if (!studentRow) {
    await sendRegistrationPrompt(chatId);
    return;
  }

  // 3) Registered → Main menu
  await showMainMenu(chatId, userId, studentRow, null);
}

async function showMainMenu(chatId, userId, studentRow, textMenuId = null) {
  const name = studentRow?.full_name || 'Student';

  // reset session state and clear tracked text-menu id
  await saveSession({
    telegram_id: userId,
    state: 'IDLE',
    data: { student_id: studentRow?.id || null, menu_message_id: null },
  });

  // delete existing text menu if we know it
  if (textMenuId) {
    try {
      await callTelegram('deleteMessage', {
        chat_id: chatId,
        message_id: textMenuId,
      });
    } catch (e) {
      console.error('delete menu message error', e);
    }
  }

  // send main menu as photo with caption + inline buttons
  await callTelegram('sendPhoto', {
    chat_id: chatId,
    photo: 'https://t.me/MyBotDatabase/9',
    caption:
      `Hi ${name}! 👋 ✨ \n *Welcome to the A/L MCQ practice bot. 🤖 (AL MCQ BOT වෙතට ඔබව සාදරයෙන් පිළිගන්නවා.)*\n\n` +
      '*👇 Choose an option:*  \n\n' +
      '*• Practice MCQs* 📝 (ඔබට අවශ්‍ය විශයට අදාල බහුවරණ, පාඩම් වශයෙන්, වාර වශයෙන් හෝ උසස් පෙල විභාගයට අදාලව පුහුණුවීම් කරන්න.)  \n\n' +
      '*• Weekly Paper* 📅 (සතිපතා ලැබෙන ප්‍රශ්ණ පත්‍රය ලියා ඔබගේ මට්ටම මැනගන්න.)',
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📚 Practice MCQs', callback_data: 'menu_practice' }],
        [{ text: '🏆 Weekly Paper', callback_data: 'menu_weekly' }],
        [{ text: 'ℹ️ About Us', callback_data: 'menu_about' }],
      ],
    },
  });
}

// helper: send/edit unified text menu and store its message_id
async function sendMenuAndStore(session, chatId, text, keyboard) {
  const existingId = session.data.menu_message_id || null;

  const res = await sendOrEditMenu({
    chatId,
    messageId: existingId,
    text,
    keyboard,
  });

  const newId = res?.result?.message_id ?? existingId;
  session.data.menu_message_id = newId;
  await saveSession(session);
  return newId;
}

// ---- PRACTICE FLOW ----
async function handlePracticeMenu(chatId, userId) {
  const session = await getSession(userId);
  session.state = 'CHOOSING_SUBJECT';
  session.data = session.data || {};

  await sendMenuAndStore(
    session,
    chatId,
    '*📚 Practice MCQs Select a subject (ඔබට අවශ්‍ය විශය තෝරන්න)* 👇:\n\n' +
      '*• Physics* ⚛️   (භෞතික විද්‍යාව)  \n' +
      '*• Chemistry* 🧪 (රසායන විද්‍යාව)  \n' +
      '*• Bio* 🧬       (ජීව විද්‍යාව)  \n' +
      '*• Maths* 📐     (සං‍යුක්ත ගණිතය)',
    [
      [
        { text: 'Physics', callback_data: 'practice_subject_1' },
        { text: 'Chemistry', callback_data: 'practice_subject_2' },
      ],
      [
        { text: 'Bio', callback_data: 'practice_subject_3' },
        { text: 'Maths', callback_data: 'practice_subject_4' },
      ],
      [{ text: '⬅️ Main Menu', callback_data: 'goto_main_menu' }],
    ]
  );
}

function subjectLabel(id) {
  return { 1: 'Physics', 2: 'Chemistry', 3: 'Bio', 4: 'Maths' }[id] || 'Subject';
}

async function handleSubjectChosen(chatId, userId, subjectId) {
  const session = await getSession(userId);
  session.state = 'CHOOSING_TYPE';
  session.data = { ...session.data, subjectId, practiceType: null, lesson: null, term: null };

  await sendMenuAndStore(
    session,
    chatId,
    `✅ ${subjectLabel(subjectId)} selected. *What do you want to practice? 🤔 (ඔබට පුහුණු වීමට අවශ්‍ය ක්‍රමය තෝරන්න)*  \n\n` +
      `*• Lesson target MCQs* 📖 (තෝරාගන්නා පාඩමකට අදාල බහුවරණ)  \n\n` +
      `*• A/L exam target MCQs* 🎓 (මුලු විෂය නිර්දේශයම ආවරණය වන පරිදි බහුවරණ)  \n\n` +
      `*• Term test target MCQs* 🗓️ (යම් වාරයකට අදාල බහුවරණ)`,
    [
      [{ text: 'Lesson target MCQs', callback_data: 'practice_type_lesson' }],
      [{ text: 'A/L exam target MCQs', callback_data: 'practice_type_exam' }],
      [{ text: 'Term test target MCQs', callback_data: 'practice_type_term' }],
      [{ text: '⬅️ Back to subjects', callback_data: 'menu_practice' }],
    ]
  );
}

// ---- LESSON / TERM LISTS ----
async function sendLessonChooser(chatId, session) {
  const subjectId = session.data.subjectId;

  const { data, error } = await supabase
    .from('practice_questions')
    .select('lesson')
    .eq('subject_id', subjectId)
    .not('lesson', 'is', null)
    .order('lesson', { ascending: true });

  if (error || !data || data.length === 0) {
    await sendMenuAndStore(
      session,
      chatId,
      'No lessons found for this subject.',
      [[{ text: '⬅️ Back', callback_data: 'menu_practice' }]]
    );
    return;
  }

  const lessons = [...new Set(data.map((r) => r.lesson))].sort((a, b) => a - b);

  const rows = [];
  for (let i = 0; i < lessons.length; i += 2) {
    const row = [];
    row.push({
      text: `Lesson ${lessons[i]}`,
      callback_data: `practice_lesson_${lessons[i]}`,
    });
    if (lessons[i + 1]) {
      row.push({
        text: `Lesson ${lessons[i + 1]}`,
        callback_data: `practice_lesson_${lessons[i + 1]}`,
      });
    }
    rows.push(row);
  }
  rows.push([{ text: '⬅️ Back', callback_data: 'menu_practice' }]);

  await sendMenuAndStore(session, chatId, '📍 Select a lesson (ඔබට අවශ්‍ය පාඩම තෝරාගන්න):', rows);
}

async function sendTermChooser(chatId, session) {
  const subjectId = session.data.subjectId;

  const { data, error } = await supabase
    .from('practice_questions')
    .select('term')
    .eq('subject_id', subjectId)
    .not('term', 'is', null);

  if (error || !data || data.length === 0) {
    await sendMenuAndStore(
      session,
      chatId,
      'No terms found for this subject.',
      [[{ text: '⬅️ Back', callback_data: 'menu_practice' }]]
    );
    return;
  }

  const terms = [...new Set(data.map((r) => r.term))].sort();

  const rows = [];
  terms.forEach((term) => {
    const encoded = encodeURIComponent(term);
    rows.push([{ text: term, callback_data: `practice_term_${encoded}` }]);
  });
  rows.push([{ text: '⬅️ Back', callback_data: 'menu_practice' }]);

  await sendMenuAndStore(session, chatId, '📍 Select a term (ඔබට අවශ්‍ය වාරය තෝරාගන්න):', rows);
}

async function sendQuestionCountChooser(chatId, session) {
  session.state = 'CHOOSING_QCOUNT';

  await sendMenuAndStore(
    session,
    chatId,
    '❓ How many questions? (ඔබට බහුවරණ කීයක් අවශ්‍යද?)',
    [
      [
        { text: '10', callback_data: 'practice_qcount_10' },
        { text: '20', callback_data: 'practice_qcount_20' },
        { text: '30', callback_data: 'practice_qcount_30' },
      ],
      [
        { text: '40', callback_data: 'practice_qcount_40' },
        { text: '50', callback_data: 'practice_qcount_50' },
      ],
      [{ text: '⬅️ Back', callback_data: 'menu_practice' }],
    ]
  );
}

// ---- START PRACTICE QUIZ (respects available count) ----
async function startPracticeQuiz(chatId, userId, requestedCount) {
  let session = await getSession(userId);
  const { subjectId, practiceType, lesson, term } = session.data;

  let query = supabase
    .from('practice_questions')
    .select('*')
    .eq('subject_id', subjectId);

  if (practiceType === 'lesson') {
    query = query.eq('lesson', lesson);
  } else if (practiceType === 'term') {
    query = query.eq('term', term);
  } else if (practiceType === 'exam') {
    query = query.eq('is_exam_target', true);
  }

  const { data, error } = await query;
  if (error || !data || data.length === 0) {
    await callTelegram('sendMessage', {
      chat_id: chatId,
      text: 'No questions found for this selection.',
    });
    return;
  }

  const availableCount = data.length;
  const finalCount = Math.min(requestedCount, availableCount);

  if (availableCount < requestedCount) {
    await callTelegram('sendMessage', {
      chat_id: chatId,
      text:
        `Only ${availableCount} questions are available for this selection.\n` +
        `You will practice ${finalCount} questions.`,
    });
  }

  // Shuffle
  const shuffled = [...data];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const questions = shuffled.slice(0, finalCount);

  session.state = 'QUIZ_ACTIVE';
  session.data = {
    ...session.data,
    mode: 'practice',
    qcount: finalCount,
    questions,
    currentIndex: 0,
    score: 0,
    answers: [],
    startedAt: Date.now(),
    menu_message_id: null,
  };
  await saveSession(session);

  await callTelegram('sendMessage', { chat_id: chatId, text: '👀' });

  await sendCurrentQuestion(chatId, session);
}

function answerLabel(idx) {
  return ['A', 'B', 'C', 'D'][idx - 1] || '?';
}

// ---- COMMON QUESTION SENDER (works for practice & weekly) ----
async function sendCurrentQuestion(chatId, session) {
  const { questions, currentIndex, qcount } = session.data;
  const q = questions[currentIndex];

  const subjectName = subjectLabel(q.subject_id);

  const text =
    `*Q${currentIndex + 1}/${qcount} - ${subjectName}*\n\n` +
    `*${q.question}*\n\n` +
    `A) ${q.answer_1}\n` +
    `B) ${q.answer_2}\n` +
    `C) ${q.answer_3}\n` +
    `D) ${q.answer_4}`;

  await callTelegram('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'A', callback_data: 'quiz_answer_1' },
          { text: 'B', callback_data: 'quiz_answer_2' },
        ],
        [
          { text: 'C', callback_data: 'quiz_answer_3' },
          { text: 'D', callback_data: 'quiz_answer_4' },
        ],
        [{ text: '🏳️ Give Up', callback_data: 'quiz_giveup' }],
      ],
    },
  });
}

// ---- ANSWER HANDLER (shared) ----
async function handleQuizAnswer(callbackQuery, chosenIndex) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  let session = await getSession(userId);
  if (session.state !== 'QUIZ_ACTIVE') return;

  const data = session.data;
  const { questions, currentIndex } = data;
  const q = questions[currentIndex];

  const correct = q.correct_answer;
  const isCorrect = correct === chosenIndex;

  data.score = (data.score || 0) + (isCorrect ? 1 : 0);
  data.answers.push({
    question_id: q.id,
    chosen_answer: chosenIndex,
    correct_answer: correct,
    is_correct: isCorrect,
  });

  const resultText =
    `*Q${currentIndex + 1}:* *${q.question}*\n\n` +
    `✅ Correct answer: *${answerLabel(correct)}*\n` +
    `📝 Your answer: *${answerLabel(chosenIndex)}*\n\n` +
    (q.explanation ? `*Explanation:* ${q.explanation}` : '');

  await callTelegram('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: resultText,
    parse_mode: 'Markdown',
  });

  const totalQuestions = questions.length;

  if (currentIndex + 1 >= totalQuestions) {
    session.state = 'QUIZ_FINISHED';
    await saveSession(session);
    await sendPracticeResult(chatId, session);
  } else {
    data.currentIndex += 1;
    await saveSession(session);
    await sendCurrentQuestion(chatId, session);
  }
}

// ---- GIVE UP HANDLER (shows explanation, then finishes) ----
async function handleQuizGiveUp(callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  let session = await getSession(userId);
  if (session.state !== 'QUIZ_ACTIVE') return;

  const data = session.data;
  const { questions, currentIndex } = data;
  const q = questions[currentIndex];

  const correct = q.correct_answer;

  data.answers.push({
    question_id: q.id,
    chosen_answer: null,
    correct_answer: correct,
    is_correct: false,
  });

  const resultText =
    `*Q${currentIndex + 1}:* *${q.question}*\n\n` +
    `✅ Correct answer: *${answerLabel(correct)}*\n` +
    `🚩 You gave up this question.\n\n` +
    (q.explanation ? `*Explanation:* ${q.explanation}` : '');

  await callTelegram('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: resultText,
    parse_mode: 'Markdown',
  });

  session.state = 'QUIZ_FINISHED';
  await saveSession(session);
  await sendPracticeResult(chatId, session, { gaveUp: true });
}

// ---- RESULT (saves practice to practice_sessions, weekly to weekly_results) ----
async function sendPracticeResult(chatId, session, opts = {}) {
  const { qcount, score, mode } = session.data;
  const gaveUp = opts.gaveUp;
  const isWeekly = mode === 'weekly';

  const text =
    `📊 *${isWeekly ? 'Weekly paper' : 'Practice session'} finished*\n\n` +
    `Score: *${score}/${qcount}*\n` +
    (gaveUp ? '_You ended the quiz early._\n\n' : '\n') +
    'Tap *Main Menu* to continue.';

  await callTelegram('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'goto_main_menu' }]],
    },
  });

  // Full score emoji 🏆
  if (score === qcount && qcount > 0) {
    await callTelegram('sendMessage', { chat_id: chatId, text: '🏆' });
  }

  try {
    const studentRow = await isRegistered(session.telegram_id);

    if (isWeekly) {
      const weekStart =
        session.data.weekly_week_start || new Date().toISOString().slice(0, 10);
      const stream = session.data.weekly_stream || 'Bio';

      await supabase.from('weekly_results').insert({
        week_start: weekStart,
        telegram_id: session.telegram_id,
        student_id: studentRow?.id || null,
        stream,
        score,
        total_questions: qcount,
      });
      return;
    }

    const correct = score;
    const total = qcount;
    const now = new Date();

    await supabase.from('practice_sessions').insert({
      student_id: studentRow?.id || null,
      telegram_id: session.telegram_id,
      subject_id: session.data.subjectId,
      practice_type: session.data.practiceType,
      lesson: session.data.lesson,
      term: session.data.term,
      question_count: total,
      correct_count: correct,
      total_time_ms: null,
      avg_time_ms: null,
      started_at: now.toISOString(),
      finished_at: now.toISOString(),
    });
  } catch (e) {
    console.error('Error saving result', e);
  }
}

// ---- WEEKLY PAPER (menus + quiz) ----
async function handleWeeklyMenu(chatId, userId) {
  const session = await getSession(userId);
  session.state = 'WEEKLY_MENU';

  await sendMenuAndStore(
    session,
    chatId,
    '🏆 *Weekly Paper Choose your stream (ඔබගේ විශය ධාරාව තෝරන්න) 👇:*  \n\n' +
      '*• Bio stream* 🩺 (විද්‍යා)  \n' +
      '*• Maths stream* 📐 (ගණිත)',
    [
      [
        { text: 'Bio Stream', callback_data: 'weekly_stream_bio' },
        { text: 'Maths Stream', callback_data: 'weekly_stream_maths' },
      ],
      [{ text: '⬅️ Main Menu', callback_data: 'goto_main_menu' }],
    ]
  );
}

async function handleWeeklyStream(chatId, userId, stream) {
  const session = await getSession(userId);
  session.state = 'WEEKLY_STREAM';
  session.data.weekly_stream = stream === 'bio' ? 'Bio' : 'Maths';

  const streamLabel = stream === 'bio' ? 'Bio Stream' : 'Maths Stream';

  await sendMenuAndStore(
    session,
    chatId,
    `*🏆 Weekly Paper –* ${streamLabel}\n\n` +
      `*Attend the paper now or see the Top 10 in the Web App.* ✍️🥇 \n` +
      `(ප්‍රශ්ණ පත්‍රයට සහභාගී වන්න, නැති නම් වැඩිම ලකුණු ලබාගත් මුල් 10දෙනා බලන්න.)`,
    [
      [
        {
          text: '✏️ Attend Paper',
          callback_data: stream === 'bio' ? 'weekly_attend_bio' : 'weekly_attend_maths',
        },
      ],
      [
        {
          text: '🏅 View Top 10',
          web_app: { url: `${TOP10_WEBAPP_URL}?stream=${stream}` },
        },
      ],
      [{ text: '⬅️ Back', callback_data: 'menu_weekly' }],
    ]
  );
}

async function startWeeklyQuiz(chatId, userId, stream) {
  let session = await getSession(userId);

  const { data: wq, error } = await supabase
    .from('weekly_questions')
    .select('week_start, subject_id, question_id')
    .order('week_start', { ascending: false });

  if (error || !wq || wq.length === 0) {
    await callTelegram('sendMessage', {
      chat_id: chatId,
      text: 'Weekly paper is not available yet.',
    });
    return;
  }

  const latestWeek = wq[0].week_start;
  const thisWeekRows = wq.filter((r) => r.week_start === latestWeek);

  const allowedSubjects = stream === 'bio' ? [1, 2, 3] : [1, 2, 4];
  const filtered = thisWeekRows.filter((r) =>
    allowedSubjects.includes(r.subject_id)
  );

  if (filtered.length === 0) {
    await callTelegram('sendMessage', {
      chat_id: chatId,
      text: 'No questions found for this weekly paper.',
    });
    return;
  }

  const qIds = filtered.map((r) => r.question_id);

  const { data: questions, error: qErr } = await supabase
    .from('practice_questions')
    .select('*')
    .in('id', qIds);

  if (qErr || !questions || questions.length === 0) {
    console.error('weekly quiz load error', qErr);
    await callTelegram('sendMessage', {
      chat_id: chatId,
      text: 'Failed to load weekly paper questions.',
    });
    return;
  }

  const map = new Map(questions.map((q) => [q.id, q]));
  const orderedQuestions = filtered
    .map((r) => map.get(r.question_id))
    .filter(Boolean);

  if (orderedQuestions.length === 0) {
    await callTelegram('sendMessage', {
      chat_id: chatId,
      text: 'Failed to prepare weekly paper questions.',
    });
    return;
  }

  session.state = 'QUIZ_ACTIVE';
  session.data = {
    ...session.data,
    mode: 'weekly',
    weekly_week_start: latestWeek,
    weekly_stream: stream === 'bio' ? 'Bio' : 'Maths',
    qcount: orderedQuestions.length,
    questions: orderedQuestions,
    currentIndex: 0,
    score: 0,
    answers: [],
    startedAt: Date.now(),
    menu_message_id: null,
  };
  await saveSession(session);

  await callTelegram('sendMessage', { chat_id: chatId, text: '👀' });

  await sendCurrentQuestion(chatId, session);
}

// ---- ABOUT ----
async function handleAbout(chatId, userId) {
  const session = await getSession(userId);
  session.state = 'ABOUT';

  await sendMenuAndStore(
    session,
    chatId,
    'ℹ️ *About Us*\n\n' +
      'This bot helps A/L students practice MCQs in Physics, Chemistry, Bio and Maths.\n' +
      '• Lesson, term and exam‑target practice\n' +
      '• Weekly mixed papers with rankings\n' +
      '• Web App is used only for registration and Top 10 leaderboard.',
    [[{ text: '⬅️ Main Menu', callback_data: 'goto_main_menu' }]]
  );
}

// ---------------------------
// BROADCAST (Admins only)
// ---------------------------
function buildInlineKeyboard(buttons = []) {
  // One button per row
  return {
    inline_keyboard: buttons.map((b) => [{ text: b.text, url: b.url }]),
  };
}

async function sendOrEditBroadcastControlMenu(session, chatId) {
  const bc = session.data.broadcast || { posts: [], buttons: [] };
  const text =
    `📣 Broadcast builder\n` +
    `Posts in queue: ${bc.posts?.length || 0}\n` +
    `Buttons: ${bc.buttons?.length || 0}\n\n` +
    `Choose an option:`;

  const keyboard = [
    [
      { text: '➕ Send another post', callback_data: 'bc_add_post' },
      { text: '🔗 Add buttons', callback_data: 'bc_add_buttons' },
    ],
    [
      { text: '✅ Confirm sending', callback_data: 'bc_confirm' },
      { text: '❌ Cancel', callback_data: 'bc_cancel' },
    ],
  ];

  const controlId = bc.control_message_id || null;
  const res = await sendOrEditMenu({
    chatId,
    messageId: controlId,
    text,
    keyboard,
  });
  const newId = res?.result?.message_id ?? controlId;

  session.data.broadcast.control_message_id = newId;
  await saveSession(session);
}

async function startBroadcast(chatId, userId) {
  let session = await getSession(userId);
  if (!isAdmin(userId)) {
    await callTelegram('sendMessage', {
      chat_id: chatId,
      text: 'You are not allowed to use this command.',
    });
    return;
  }

  session.state = 'BROADCAST_AWAITING_CONTENT';
  session.data = session.data || {};
  session.data.broadcast = {
    posts: [],
    buttons: [],
    preview_message_ids: [],
    control_message_id: null,
  };
  await saveSession(session);

  await callTelegram('sendMessage', {
    chat_id: chatId,
    text:
      'Send the post you want to broadcast (text, photo, video, etc.).\n' +
      'You can add multiple posts. When done, choose options below.',
  });
}

async function handleBroadcastMessage(message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  let session = await getSession(userId);

  if (!isAdmin(userId)) return false;
  if (!session.state || !session.state.startsWith('BROADCAST_')) return false;

  session.data = session.data || {};
  session.data.broadcast = session.data.broadcast || {
    posts: [],
    buttons: [],
    preview_message_ids: [],
    control_message_id: null,
  };
  const bc = session.data.broadcast;

  // Collect content
  if (session.state === 'BROADCAST_AWAITING_CONTENT') {
    bc.posts.push({
      src_chat_id: chatId,
      src_message_id: message.message_id,
    });

    const copyRes = await callTelegram('copyMessage', {
      chat_id: chatId,
      from_chat_id: chatId,
      message_id: message.message_id,
      ...(bc.buttons.length
        ? { reply_markup: buildInlineKeyboard(bc.buttons) }
        : {}),
    });

    const previewId = copyRes?.result?.message_id;
    if (previewId) {
      bc.preview_message_ids.push(previewId);
    }

    await saveSession(session);
    await sendOrEditBroadcastControlMenu(session, chatId);
    return true;
  }

  // Collect buttons
  if (session.state === 'BROADCAST_AWAITING_BUTTONS') {
    const text = (message.text || '').trim();
    if (!text) {
      await callTelegram('sendMessage', {
        chat_id: chatId,
        text:
          'Please send buttons in lines like:\n' +
          'Button 1 - https://example.com\n' +
          'Button 2 - https://another.com',
      });
      return true;
    }

    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const newButtons = [];
    let autoIndex = 1;
    for (const line of lines) {
      let label = '';
      let url = '';
      const parts = line.split(' - ');
      if (parts.length >= 2) {
        label = parts[0].trim();
        url = parts.slice(1).join(' - ').trim();
      } else {
        url = parts[0].trim();
        try {
          const u = new URL(url);
          label = u.hostname.replace(/^www\./, '');
        } catch {
          label = `Link ${autoIndex}`;
        }
      }
      if (!/^https?:\/\//i.test(url)) continue;
      newButtons.push({ text: label || `Link ${autoIndex}`, url });
      autoIndex += 1;
    }

    if (!newButtons.length) {
      await callTelegram('sendMessage', {
        chat_id: chatId,
        text: 'No valid buttons detected. Please try again.',
      });
      return true;
    }

    bc.buttons = newButtons;

    for (const mid of bc.preview_message_ids || []) {
      await callTelegram('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: mid,
        reply_markup: buildInlineKeyboard(bc.buttons),
      });
    }

    session.state = 'BROADCAST_READY';
    await saveSession(session);
    await callTelegram('sendMessage', {
      chat_id: chatId,
      text: 'Buttons added and preview updated.',
    });
    await sendOrEditBroadcastControlMenu(session, chatId);
    return true;
  }

  return false;
}

async function performBroadcast(session, adminChatId) {
  const { data: students, error } = await supabase
    .from('students')
    .select('telegram_id')
    .not('telegram_id', 'is', null);

  if (error) {
    console.error('broadcast recipients load error', error);
    await callTelegram('sendMessage', {
      chat_id: adminChatId,
      text: 'Failed to load recipients.',
    });
    return;
  }

  const ids = Array.from(
    new Set(
      (students || [])
        .map((s) => Number(s.telegram_id))
        .filter((n) => Number.isFinite(n) && n > 0)
    )
  );

  const bc = session.data.broadcast || { posts: [], buttons: [] };
  const keyboard = bc.buttons?.length ? buildInlineKeyboard(bc.buttons) : null;

  let sent = 0;
  let failed = 0;

  for (const uid of ids) {
    for (const post of bc.posts) {
      try {
        await callTelegram('copyMessage', {
          chat_id: uid,
          from_chat_id: post.src_chat_id,
          message_id: post.src_message_id,
          ...(keyboard ? { reply_markup: keyboard } : {}),
        });
        sent += 1;
      } catch (e) {
        failed += 1;
      }
    }
    await new Promise((r) => setTimeout(r, 20));
  }

  await callTelegram('sendMessage', {
    chat_id: adminChatId,
    text: `Broadcast finished.\nDelivered: ${sent}\nFailed: ${failed}\nRecipients: ${ids.length}\nPosts: ${bc.posts.length}`,
  });
}

// ---- EDIT PROFILE: prompt ----
async function sendEditProfilePrompt(chatId, userId) {
  if (!PROFILE_WEBAPP_URL) {
    await callTelegram('sendMessage', {
      chat_id: chatId,
      text: 'Profile editor is not configured. Please set PROFILE_WEBAPP_URL.',
    });
    return;
  }
  const url =
    PROFILE_WEBAPP_URL +
    (PROFILE_WEBAPP_URL.includes('?') ? '&' : '?') +
    `mode=edit&tg_id=${userId}`;

  await callTelegram('sendMessage', {
    chat_id: chatId,
    text: 'Open the Web App to edit your profile:',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✏️ Edit Profile', web_app: { url } }],
        [{ text: '❌ Cancel', callback_data: 'noop' }],
      ],
    },
  });
}

// ---- MESSAGE HANDLER ----
async function handleMessage(message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = (message.text || '').trim();

  // /editprofile for everyone
  if (text.toLowerCase().startsWith('/editprofile')) {
    await sendEditProfilePrompt(chatId, userId);
    return;
  }

  // Admin broadcast command
  if (text.toLowerCase().startsWith('/broadcast')) {
    if (!isAdmin(userId)) {
      await callTelegram('sendMessage', {
        chat_id: chatId,
        text: 'You are not allowed to use this command.',
      });
      return;
    }
    await startBroadcast(chatId, userId);
    return;
  }

  // Handle ongoing broadcast states (admins)
  const session = await getSession(userId);
  if (isAdmin(userId) && session.state && session.state.startsWith('BROADCAST_')) {
    const handled = await handleBroadcastMessage(message);
    if (handled) return;
  }

  if (text.toLowerCase().startsWith('/start')) {
    await handleStart(message);
    return;
  }

  await callTelegram('sendMessage', {
    chat_id: chatId,
    text: 'Use /start to open the main menu.',
  });
}

// ---- CALLBACK HANDLER ----
async function handleCallback(callbackQuery) {
  const { data } = callbackQuery;
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const messageId = callbackQuery.message.message_id;
  const isPhoto = !!callbackQuery.message.photo;

  await callTelegram('answerCallbackQuery', {
    callback_query_id: callbackQuery.id,
  });

  // Broadcast admin controls
  if (isAdmin(userId) && data.startsWith('bc_')) {
    let session = await getSession(userId);
    session.data = session.data || {};
    session.data.broadcast = session.data.broadcast || {
      posts: [],
      buttons: [],
      preview_message_ids: [],
      control_message_id: null,
    };

    if (data === 'bc_add_post') {
      session.state = 'BROADCAST_AWAITING_CONTENT';
      await saveSession(session);
      await callTelegram('sendMessage', {
        chat_id: chatId,
        text: 'Send another post (text/photo/video/etc)...',
      });
      return;
    }

    if (data === 'bc_add_buttons') {
      session.state = 'BROADCAST_AWAITING_BUTTONS';
      await saveSession(session);
      await callTelegram('sendMessage', {
        chat_id: chatId,
        text:
          'Send buttons (one per line) in the format:\n' +
          'Button 1 - https://example.com\n' +
          'Button 2 - https://another.com',
      });
      return;
    }

    if (data === 'bc_confirm') {
      if (!session.data.broadcast.posts?.length) {
        await callTelegram('sendMessage', {
          chat_id: chatId,
          text: 'No posts to send. Please add at least one post.',
        });
        return;
      }
      await callTelegram('sendMessage', {
        chat_id: chatId,
        text: 'Broadcast started. Please wait...',
      });
      await performBroadcast(session, chatId);

      // Reset state
      session.state = 'IDLE';
      session.data.broadcast = null;
      await saveSession(session);
      return;
    }

    if (data === 'bc_cancel') {
      session.state = 'IDLE';
      session.data.broadcast = null;
      await saveSession(session);
      await callTelegram('sendMessage', {
        chat_id: chatId,
        text: 'Broadcast cancelled.',
      });
      return;
    }
  }

  // Gatekeeper "Done & Start" – delete message then rerun /start
  if (data === 'done_join') {
    try {
      await callTelegram('deleteMessage', { chat_id: chatId, message_id: messageId });
    } catch (e) {}
    await handleStart({ chat: { id: chatId }, from: { id: callbackQuery.from.id } });
    return;
  }

  // Registration check – delete video, then either show menu or send again
  if (data === 'check_registered') {
    try {
      await callTelegram('deleteMessage', { chat_id: chatId, message_id: messageId });
    } catch (e) {}

    const studentRow = await isRegistered(userId);
    if (!studentRow) {
      await sendRegistrationPrompt(chatId);
      return;
    }
    await showMainMenu(chatId, userId, studentRow, null);
    return;
  }

  if (data === 'goto_main_menu') {
    const studentRow = await isRegistered(userId);
    const session = await getSession(userId);
    const menuId = session.data.menu_message_id || null;
    await showMainMenu(chatId, userId, studentRow || {}, menuId);
    return;
  }

  // main menu buttons: delete photo, then open/edit text menu
  if (data === 'menu_practice') {
    if (isPhoto) {
      try {
        await callTelegram('deleteMessage', { chat_id: chatId, message_id: messageId });
      } catch (e) {}
      const session = await getSession(userId);
      session.data.menu_message_id = null;
      await saveSession(session);
    }
    await handlePracticeMenu(chatId, userId);
    return;
  }

  if (data === 'menu_weekly') {
    if (isPhoto) {
      try {
        await callTelegram('deleteMessage', { chat_id: chatId, message_id: messageId });
      } catch (e) {}
      const session = await getSession(userId);
      session.data.menu_message_id = null;
      await saveSession(session);
    }
    await handleWeeklyMenu(chatId, userId);
    return;
  }

  if (data === 'menu_about') {
    if (isPhoto) {
      try {
        await callTelegram('deleteMessage', { chat_id: chatId, message_id: messageId });
      } catch (e) {}
      const session = await getSession(userId);
      session.data.menu_message_id = null;
      await saveSession(session);
    }
    await handleAbout(chatId, userId);
    return;
  }

  if (data.startsWith('practice_subject_')) {
    const id = parseInt(data.split('_').pop(), 10);
    await handleSubjectChosen(chatId, userId, id);
    return;
  }

  if (
    data === 'practice_type_lesson' ||
    data === 'practice_type_term' ||
    data === 'practice_type_exam'
  ) {
    const session = await getSession(userId);
    session.data.practiceType =
      data === 'practice_type_lesson'
        ? 'lesson'
        : data === 'practice_type_term'
        ? 'term'
        : 'exam';
    await saveSession(session);

    if (session.data.practiceType === 'lesson') {
      await sendLessonChooser(chatId, session);
    } else if (session.data.practiceType === 'term') {
      await sendTermChooser(chatId, session);
    } else {
      await sendQuestionCountChooser(chatId, session);
    }
    return;
  }

  if (data.startsWith('practice_lesson_')) {
    const lesson = parseInt(data.split('_').pop(), 10);
    const session = await getSession(userId);
    session.data.lesson = lesson;
    await saveSession(session);
    await sendQuestionCountChooser(chatId, session);
    return;
  }

  if (data.startsWith('practice_term_')) {
    const encoded = data.replace('practice_term_', '');
    const term = decodeURIComponent(encoded);
    const session = await getSession(userId);
    session.data.term = term;
    await saveSession(session);
    await sendQuestionCountChooser(chatId, session);
    return;
  }

  if (data.startsWith('practice_qcount_')) {
    const qcount = parseInt(data.split('_').pop(), 10);

    const session = await getSession(userId);
    const menuId = session.data.menu_message_id;
    if (menuId) {
      try {
        await callTelegram('deleteMessage', {
          chat_id: chatId,
          message_id: menuId,
        });
      } catch (e) {}
    }

    await startPracticeQuiz(chatId, userId, qcount);
    return;
  }

  if (data.startsWith('quiz_answer_')) {
    const idx = parseInt(data.split('_').pop(), 10);
    await handleQuizAnswer(callbackQuery, idx);
    return;
  }

  if (data === 'quiz_giveup') {
    await handleQuizGiveUp(callbackQuery);
    return;
  }

  if (data === 'weekly_stream_bio') {
    await handleWeeklyStream(chatId, userId, 'bio');
    return;
  }
  if (data === 'weekly_stream_maths') {
    await handleWeeklyStream(chatId, userId, 'maths');
    return;
  }

  if (data === 'weekly_attend_bio') {
    const session = await getSession(userId);
    const menuId = session.data.menu_message_id;
    if (menuId) {
      try {
        await callTelegram('deleteMessage', { chat_id: chatId, message_id: menuId });
      } catch (e) {}
    }
    await startWeeklyQuiz(chatId, userId, 'bio');
    return;
  }

  if (data === 'weekly_attend_maths') {
    const session = await getSession(userId);
    const menuId = session.data.menu_message_id;
    if (menuId) {
      try {
        await callTelegram('deleteMessage', { chat_id: chatId, message_id: menuId });
      } catch (e) {}
    }
    await startWeeklyQuiz(chatId, userId, 'maths');
    return;
  }

  if (data === 'noop') return;
}

// ---- VERCEL HANDLER ----
export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).send('OK');
  }
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  const update = req.body;

  try {
    if (update.message) {
      await handleMessage(update.message);
    } else if (update.callback_query) {
      await handleCallback(update.callback_query);
    }
  } catch (err) {
    console.error('Update handling error', err);
  }

  return res.status(200).json({ ok: true });
}
