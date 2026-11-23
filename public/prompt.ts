// The one prompt every creation step uses: a title, a line saying what is being made, one field
// holding a default name with all of it selected, and Continue or Cancel. Backspace and type a name
// then Continue, or Continue to accept the default. Continue runs the step's own work; a problem it
// returns is shown under the field and the prompt stays open, so nothing is lost to a typo.

/** What one prompt asks. */
export interface IPrompt
{
  /** The heading, such as "New layer". */
  title: string;
  /** One line about what is being made and where. */
  caption: string;
  /** The default name, which opens selected. */
  value: string;
  /**
   * Does the work with the name given. Returns the reason it cannot, shown in the prompt, or null when it
   * is done, which closes the prompt.
   */
  submit: (value: string) => Promise<string | null>;
}

let backdrop: HTMLDivElement | null = null;
let current: { finish: (done: boolean) => void } | null = null;

function build(): HTMLDivElement
{
  const box = document.createElement("div");
  box.id = "askbox";
  box.hidden = true;
  box.innerHTML =
    '<form class="ask-card" autocomplete="off">' +
    '<h2 data-ask="title"></h2><p data-ask="caption"></p>' +
    '<input data-ask="field" type="text" enterkeyhint="done" spellcheck="false" autocapitalize="off" autocorrect="off">' +
    '<p data-ask="error" role="alert" hidden></p>' +
    '<div class="ask-actions"><button type="button" data-ask="cancel">Cancel</button><button type="submit" data-ask="continue">Continue</button></div>' +
    '</form>';
  document.body.appendChild(box);
  return box;
}

function part<T extends HTMLElement>(name: string): T
{
  return backdrop!.querySelector("[data-ask='" + name + "']") as T;
}

/** Whether a prompt is open now. */
export function promptOpen(): boolean
{
  return current !== null;
}

/**
 * Opens the prompt and waits for it to end.
 * @param prompt what to ask
 * @returns true when the work was done, false when it was cancelled
 */
export function ask(prompt: IPrompt): Promise<boolean>
{
  current?.finish(false);
  backdrop ??= build();
  const box = backdrop;
  const field = part<HTMLInputElement>("field"), error = part<HTMLElement>("error");
  const form = box.querySelector("form")!;
  const cancel = part<HTMLButtonElement>("cancel"), go = part<HTMLButtonElement>("continue");
  part<HTMLElement>("title").textContent = prompt.title;
  part<HTMLElement>("caption").textContent = prompt.caption;
  field.value = prompt.value;
  error.hidden = true;
  go.disabled = cancel.disabled = false;

  return new Promise<boolean>((resolve) =>
  {
    const finish = (done: boolean): void =>
    {
      box.hidden = true;
      form.removeEventListener("submit", onSubmit);
      cancel.removeEventListener("click", onCancel);
      box.removeEventListener("keydown", onKey, true);
      current = null;
      resolve(done);
    };
    const onCancel = (): void => finish(false);
    const onSubmit = async (event: Event): Promise<void> =>
    {
      event.preventDefault();
      go.disabled = true;
      const problem = await prompt.submit(field.value.trim());
      if (problem === null) { finish(true); return; }
      go.disabled = false;
      error.textContent = problem;
      error.hidden = false;
      field.focus();
    };
    const onKey = (event: KeyboardEvent): void =>
    {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      finish(false);
    };
    form.addEventListener("submit", onSubmit);
    cancel.addEventListener("click", onCancel);
    box.addEventListener("keydown", onKey, true);
    current = { finish };
    box.hidden = false;
    // Focus after the box is shown, so the whole default is selected and the keyboard comes up on a phone.
    field.focus();
    field.select();
  });
}
