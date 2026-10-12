package com.fy.local;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Log;

import java.util.ArrayList;
import java.util.Locale;

/** 语音：TTS 朗读 + 语音识别。全部走系统能力，不需要联网。 */
public class Speech {

    private static final String TAG = "FY/Speech";

    public interface Events {
        void onStt(String text, boolean isFinal);
        void onTts(String state);
    }

    private final Context ctx;
    private final Events events;
    private final Handler main = new Handler(Looper.getMainLooper());

    private TextToSpeech tts;
    private volatile boolean ttsReady = false;
    private float rate = 1.0f;
    private SpeechRecognizer sr;
    private boolean listening = false;

    public Speech(Context ctx, Events events) {
        this.ctx = ctx.getApplicationContext();
        this.events = events;
        initTts();
    }

    private void initTts() {
        main.post(() -> {
            tts = new TextToSpeech(ctx, status -> {
                if (status == TextToSpeech.SUCCESS) {
                    ttsReady = true;
                    try {
                        tts.setLanguage(Locale.CHINA);
                        tts.setSpeechRate(rate);
                    } catch (Exception e) {
                        Log.w(TAG, "TTS 初始化语言失败: " + e);
                    }
                    Log.i(TAG, "TTS 就绪");
                    tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                        @Override
                        public void onStart(String utteranceId) {
                            if (events != null) events.onTts("start");
                        }

                        @Override
                        public void onDone(String utteranceId) {
                            if (events != null) events.onTts("done");
                        }

                        @Override
                        public void onError(String utteranceId) {
                            if (events != null) events.onTts("error");
                        }
                    });
                } else {
                    Log.w(TAG, "TTS 初始化失败: " + status);
                }
            });
        });
    }

    public void setRate(float r) {
        rate = r;
        main.post(() -> {
            if (ttsReady) {
                try {
                    tts.setSpeechRate(r);
                } catch (Exception ignored) {
                }
            }
        });
    }

    public void speak(final String text) {
        if (text == null || text.trim().isEmpty()) return;
        main.post(() -> {
            if (!ttsReady) {
                Log.w(TAG, "TTS 还没就绪，忽略本次朗读");
                if (events != null) events.onTts("error");
                return;
            }
            try {
                tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "fy-" + System.currentTimeMillis());
            } catch (Exception e) {
                Log.w(TAG, "朗读失败: " + e);
                if (events != null) events.onTts("error");
            }
        });
    }

    public void stopSpeak() {
        main.post(() -> {
            try {
                if (tts != null) tts.stop();
            } catch (Exception ignored) {
            }
        });
    }

    /** TTS 说完一句的回调（由 MainActivity 在初始化时挂上 UtteranceProgressListener 也行）。 */
    public void notifyTtsDone() {
        if (events != null) events.onTts("done");
    }

    public boolean isListening() {
        return listening;
    }

    public void startListening() {
        main.post(() -> {
            try {
                if (sr == null) {
                    if (!SpeechRecognizer.isRecognitionAvailable(ctx)) {
                        Log.w(TAG, "本机没有可用的语音识别服务");
                        if (events != null) events.onStt("", true);
                        return;
                    }
                    sr = SpeechRecognizer.createSpeechRecognizer(ctx);
                    sr.setRecognitionListener(new RecognitionListener() {
                        @Override
                        public void onReadyForSpeech(Bundle params) {
                        }

                        @Override
                        public void onBeginningOfSpeech() {
                        }

                        @Override
                        public void onRmsChanged(float rmsdB) {
                        }

                        @Override
                        public void onBufferReceived(byte[] buffer) {
                        }

                        @Override
                        public void onEndOfSpeech() {
                        }

                        @Override
                        public void onError(int error) {
                            listening = false;
                            Log.w(TAG, "语音识别出错 code=" + error);
                            if (events != null) events.onStt("", true);
                        }

                        @Override
                        public void onResults(Bundle results) {
                            listening = false;
                            String text = first(results);
                            if (events != null) events.onStt(text, true);
                        }

                        @Override
                        public void onPartialResults(Bundle partialResults) {
                            String text = first(partialResults);
                            if (events != null && text != null && !text.isEmpty()) {
                                events.onStt(text, false);
                            }
                        }

                        @Override
                        public void onEvent(int eventType, Bundle params) {
                        }

                        private String first(Bundle b) {
                            ArrayList<String> list =
                                    b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                            return (list == null || list.isEmpty()) ? "" : list.get(0);
                        }
                    });
                }
                Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                        RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN");
                i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
                i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
                listening = true;
                sr.startListening(i);
            } catch (Exception e) {
                listening = false;
                Log.w(TAG, "启动语音识别失败: " + e);
                if (events != null) events.onStt("", true);
            }
        });
    }

    public void stopListening() {
        main.post(() -> {
            listening = false;
            try {
                if (sr != null) sr.stopListening();
            } catch (Exception ignored) {
            }
        });
    }

    public void shutdown() {
        main.post(() -> {
            try {
                if (tts != null) {
                    tts.stop();
                    tts.shutdown();
                }
            } catch (Exception ignored) {
            }
            try {
                if (sr != null) {
                    sr.destroy();
                }
            } catch (Exception ignored) {
            }
            tts = null;
            sr = null;
            ttsReady = false;
        });
    }
}
