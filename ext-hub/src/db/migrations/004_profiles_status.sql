-- Appointment status per CitaMate entry. CitaMate only offers active entries
-- (pending, in_progress); the others stay in the panel.
ALTER TABLE profiles ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE profiles ADD COLUMN status_at INTEGER;
