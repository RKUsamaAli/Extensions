-- Page snapshot CitaMate attaches to failed / stuck steps (JSON): page, url, site message,
-- fields filled / missing with the selectors tried, the page's visible fields and buttons.
-- Used to fix the site config. Additive: older app versions ignore the column.
ALTER TABLE cm_logs ADD COLUMN context TEXT;
