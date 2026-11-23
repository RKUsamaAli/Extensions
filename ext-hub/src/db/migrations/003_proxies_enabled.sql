-- On/off per proxy: switched-off proxies stay in the panel but are not sent to RelaySwitch.
ALTER TABLE proxies ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
