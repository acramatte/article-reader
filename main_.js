import { KokoroTTS } from "kokoro-js";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

const loadButton = document.querySelector("#load");
const speakButton = document.querySelector("#speak");
const voiceSelect = document.querySelector("#voice");
const textArea = document.querySelector("#text");
const audioElement = document.querySelector("#audio");
const status = document.querySelector("#status");

let tts = null;
let currentAudioUrl = null;

const device = "webgpu";
const dtype = "fp16";

function report(message) {
  console.log(message);
  status.textContent = message;
}

function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(2)} s`;
}

loadButton.addEventListener("click", async () => {
  if (tts) {
    report(`Already loaded.

Backend: ${device}
dtype: ${dtype}`);
    return;
  }

  loadButton.disabled = true;

  report(
    `Loading Kokoro...

Backend: ${device}
dtype: ${dtype}

First run downloads the model.
Later runs should use the browser cache.`
  );

  const started = performance.now();

  try {
    tts = await KokoroTTS.from_pretrained(
      MODEL_ID,
      {
        device,
        dtype,

        progress_callback: (progress) => {
          console.log("model:", progress);

          if (progress?.progress != null) {
            status.textContent =
              `Loading Kokoro...\n\n` +
              `Backend: ${device}\n` +
              `dtype: ${dtype}\n` +
              `${Math.round(progress.progress)}%`;
          }
        }
      }
    );

    const elapsed = performance.now() - started;

    populateVoices();

    voiceSelect.disabled = false;
    speakButton.disabled = false;

    report(
      `Kokoro loaded.

Backend: ${device}
dtype: ${dtype}
Load time: ${formatSeconds(elapsed)}
Voices: ${Object.keys(tts.voices).length}`
    );
  } catch (error) {
    console.error(error);

    report(
      `Failed to load Kokoro.

${error.stack ?? error}`
    );

    loadButton.disabled = false;
  }
});

function populateVoices() {
  voiceSelect.innerHTML = "";

  for (const [id, voice] of Object.entries(tts.voices)) {
    const option = document.createElement("option");

    option.value = id;

    option.textContent =
      `${voice.name ?? id}` +
      `${voice.language ? ` — ${voice.language}` : ""}` +
      `${voice.traits ? ` ${voice.traits}` : ""}`;

    // A good starting voice.
    if (id === "af_heart") {
      option.selected = true;
    }

    voiceSelect.appendChild(option);
  }
}

speakButton.addEventListener("click", async () => {
  if (!tts) {
    return;
  }

  const text = textArea.value.trim();

  if (!text) {
    report("Enter some text first.");
    return;
  }

  speakButton.disabled = true;

  const voice = voiceSelect.value;

  report(
    `Generating...

Backend: ${device}
dtype: ${dtype}
Voice: ${voice}
Characters: ${text.length}`
  );

  const started = performance.now();

  try {
    const audio = await tts.generate(
      text,
      { voice }
    );

    const generationTime =
      performance.now() - started;

    const blob = audio.toBlob();

    if (currentAudioUrl) {
      URL.revokeObjectURL(currentAudioUrl);
    }

    currentAudioUrl =
      URL.createObjectURL(blob);

    audioElement.src = currentAudioUrl;

    // Wait until the browser knows the generated audio duration.
    await new Promise((resolve) => {
      audioElement.onloadedmetadata = resolve;
    });

    const duration =
      audioElement.duration;

    const realTimeFactor =
      generationTime / 1000 / duration;

    report(
      `Generated.

Backend: ${device}
dtype: ${dtype}
Voice: ${voice}

Generation: ${formatSeconds(generationTime)}
Audio: ${duration.toFixed(2)} s
Real-time factor: ${realTimeFactor.toFixed(2)}×

${realTimeFactor < 1
        ? "✓ Generation is faster than playback."
        : "⚠ Generation is slower than playback."}`
    );

    try {
      await audioElement.play();
    } catch {
      report(
        status.textContent +
        "\n\nAutoplay was blocked. Press Play on the audio control."
      );
    }
  } catch (error) {
    console.error(error);

    report(
      `Generation failed.

${error.stack ?? error}`
    );
  } finally {
    speakButton.disabled = false;
  }
});
