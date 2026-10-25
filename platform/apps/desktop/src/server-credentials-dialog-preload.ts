import { ipcRenderer } from "electron";
import { CREDENTIALS_CANCEL, CREDENTIALS_SUBMIT, type CredentialsRequest } from "./server-credentials-dialog-ipc.js";
window.addEventListener("DOMContentLoaded", () => {
  const form = document.querySelector<HTMLFormElement>("form[data-credentials]");
  if (!form) return;
  const username = form.querySelector<HTMLInputElement>("[name=username]")!;
  const password = form.querySelector<HTMLInputElement>("[name=password]")!;
  const remember = form.querySelector<HTMLInputElement>("[name=remember]")!;
  username.focus();
  form.addEventListener("submit", event => {
    event.preventDefault();
    const payload: CredentialsRequest = { username: username.value, password: password.value, remember: remember.checked };
    ipcRenderer.send(CREDENTIALS_SUBMIT, payload);
    password.value = "";
  });
  form.querySelector("[data-cancel]")!.addEventListener("click", () => ipcRenderer.send(CREDENTIALS_CANCEL));
  window.addEventListener("keydown", event => { if (event.key === "Escape") ipcRenderer.send(CREDENTIALS_CANCEL); });
});
