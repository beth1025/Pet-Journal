const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';

async function sendPushMessage(lineUserId, text) {
  const res = await fetch(LINE_PUSH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to: lineUserId,
      messages: [{ type: 'text', text }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LINE push failed: ${res.status} ${body}`);
  }
}

function daysUntil(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [y, m, d] = dateStr.split('-').map(Number);
  return Math.ceil((new Date(y, m - 1, d) - today) / 86400000);
}

function nextBirthdayDays(birthday) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [, m, d] = birthday.split('-').map(Number);
  let next = new Date(today.getFullYear(), m - 1, d);
  if (next < today) next = new Date(today.getFullYear() + 1, m - 1, d);
  return Math.ceil((next - today) / 86400000);
}

async function getUserPets(userId) {
  // Get groups this user belongs to
  const { data: memberships } = await supabase
    .from('group_members')
    .select('group_id')
    .eq('user_id', userId);

  const groupIds = (memberships || []).map((m) => m.group_id);

  let query = supabase.from('pets').select('id,name,birthday');

  if (groupIds.length > 0) {
    // Direct pets OR pets shared via groups the user is a member of
    query = query.or(`user_id.eq.${userId},group_id.in.(${groupIds.join(',')})`);
  } else {
    query = query.eq('user_id', userId);
  }

  const { data: pets } = await query;

  // Deduplicate by pet id
  const seen = new Map();
  for (const p of pets || []) seen.set(p.id, p);
  return [...seen.values()];
}

async function processUser(userId, lineUserId, reminderDays, birthdayReminderDays) {
  const pets = await getUserPets(userId);
  if (!pets.length) return { skipped: true, reason: 'no_pets' };

  const petIds = pets.map((p) => p.id);
  const petById = Object.fromEntries(pets.map((p) => [p.id, p]));

  // Fetch upcoming vaccine events
  const { data: events } = await supabase
    .from('events')
    .select('id,pet_id,content,next_due_date')
    .eq('type', 'vaccine')
    .in('pet_id', petIds)
    .not('next_due_date', 'is', null);

  const year = new Date().getFullYear();

  // Build all potential event_ids to check
  const vaccineEventIds = (events || []).map((e) => String(e.id));
  const birthdayEventIds = pets
    .filter((p) => p.birthday)
    .map((p) => `birthday-${p.id}-${year}`);
  const allCandidateIds = [...vaccineEventIds, ...birthdayEventIds];

  if (allCandidateIds.length === 0) return { skipped: true, reason: 'no_events' };

  // Check which have already been notified today
  const { data: notified } = await supabase
    .from('notification_log')
    .select('event_id')
    .in('event_id', allCandidateIds);

  const notifiedSet = new Set((notified || []).map((n) => n.event_id));

  const lines = [];
  const toLog = [];

  // Vaccine reminders (only future/today, not overdue)
  (events || [])
    .map((e) => ({ ...e, days: daysUntil(e.next_due_date) }))
    .filter((e) => e.days >= 0 && e.days <= reminderDays)
    .filter((e) => !notifiedSet.has(String(e.id)))
    .sort((a, b) => a.days - b.days)
    .forEach((e) => {
      const pet = petById[e.pet_id];
      const label = e.days === 0 ? '今天到期' : `${e.days} 天後到期`;
      lines.push(`💉 ${pet?.name || ''} - ${e.content || '疫苗'}（${label}）`);
      toLog.push(String(e.id));
    });

  // Birthday reminders
  pets
    .filter((p) => p.birthday)
    .map((p) => ({ ...p, days: nextBirthdayDays(p.birthday) }))
    .filter((p) => p.days <= birthdayReminderDays)
    .filter((p) => !notifiedSet.has(`birthday-${p.id}-${year}`))
    .sort((a, b) => a.days - b.days)
    .forEach((p) => {
      const label = p.days === 0 ? '今天生日 🎉' : `${p.days} 天後生日`;
      lines.push(`🎂 ${p.name} - ${label}`);
      toLog.push(`birthday-${p.id}-${year}`);
    });

  if (lines.length === 0) return { skipped: true, reason: 'all_notified_or_none_due' };

  const text = '🐾 寵物日誌每日提醒\n\n' + lines.join('\n');
  await sendPushMessage(lineUserId, text);

  // Record sent notifications to avoid re-sending
  const now = new Date().toISOString();
  await supabase
    .from('notification_log')
    .insert(toLog.map((event_id) => ({ event_id, notified_at: now })));

  return { sent: toLog.length };
}

module.exports = async function handler(req, res) {
  // Vercel Cron attaches Authorization: Bearer <CRON_SECRET> to every invocation
  const auth = req.headers['authorization'];
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const REMINDER_DAYS = Number(process.env.VACCINE_REMINDER_DAYS) || 30;
  const BIRTHDAY_DAYS = Number(process.env.BIRTHDAY_REMINDER_DAYS) || 30;

  try {
    const { data: bindings, error } = await supabase
      .from('line_bindings')
      .select('user_id,line_user_id');

    if (error) throw error;

    if (!bindings || bindings.length === 0) {
      return res.status(200).json({ message: 'No LINE bindings found', processed: 0 });
    }

    const results = [];
    for (const binding of bindings) {
      try {
        const result = await processUser(
          binding.user_id,
          binding.line_user_id,
          REMINDER_DAYS,
          BIRTHDAY_DAYS
        );
        results.push({ userId: binding.user_id, ...result });
      } catch (err) {
        console.error(`[cron] Error for user ${binding.user_id}:`, err.message);
        results.push({ userId: binding.user_id, status: 'error', error: err.message });
      }
    }

    return res.status(200).json({ processed: results.length, results });
  } catch (err) {
    console.error('[cron] Fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
};
