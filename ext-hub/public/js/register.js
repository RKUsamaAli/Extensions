import { register } from "./api.js";

const $ = (id) => document.getElementById(id);
const form = $("registerForm");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("error");
  err.hidden = true;
  const f = Object.fromEntries(new FormData(form));
  const problems = [];
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(String(f.username || "").trim())) problems.push("Username: 3–40 characters, letters, digits, . _ -");
  if (String(f.password || "").length < 8) problems.push("Password: at least 8 characters.");
  if (f.password !== f.password2) problems.push("The passwords don't match.");
  if (problems.length) {
    err.textContent = problems.join(" ");
    err.hidden = false;
    return;
  }
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    await register(String(f.username).trim(), f.password, String(f.email || "").trim());
    form.hidden = true;
    $("done").hidden = false;
  } catch (ex) {
    err.textContent =
      ex.code === "forbidden" ? "Sign-ups are closed. Ask the admin to create an account for you."
      : ex.code === "conflict" ? "That username is taken."
      : ex.body && ex.body.fields ? Object.values(ex.body.fields).join(" ")
      : ex.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});
