#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <napi.h>
#include <thread>
#include <atomic>

static HHOOK g_hook = nullptr;
static std::atomic<bool> g_running(false);
static DWORD g_threadId = 0;
static Napi::ThreadSafeFunction g_tsfn;

static LRESULT CALLBACK LowLevelKeyboardProc(int nCode, WPARAM wParam, LPARAM lParam) {
  if (nCode == HC_ACTION && (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN)) {
    KBDLLHOOKSTRUCT* kb = reinterpret_cast<KBDLLHOOKSTRUCT*>(lParam);
    const DWORD vkCode = kb->vkCode;
    const DWORD scanCode = kb->scanCode;
    const DWORD flags = kb->flags;

    auto callback = [vkCode, scanCode, flags](Napi::Env env, Napi::Function jsCallback) {
      Napi::Object obj = Napi::Object::New(env);
      obj.Set("vkCode", Napi::Number::New(env, vkCode));
      obj.Set("scanCode", Napi::Number::New(env, scanCode));
      obj.Set("flags", Napi::Number::New(env, flags));
      jsCallback.Call({ obj });
    };

    if (g_tsfn) {
      g_tsfn.NonBlockingCall(callback);
    }
  }

  return CallNextHookEx(g_hook, nCode, wParam, lParam);
}

static void HookThread() {
  g_hook = SetWindowsHookEx(WH_KEYBOARD_LL, LowLevelKeyboardProc, nullptr, 0);
  if (!g_hook) {
    return;
  }

  g_threadId = GetCurrentThreadId();

  MSG msg;
  while (g_running.load() && GetMessage(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessage(&msg);
  }

  UnhookWindowsHookEx(g_hook);
  g_hook = nullptr;
}

static Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (g_running.load()) {
    return Napi::Boolean::New(env, false);
  }

  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "Callback must be a function").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  g_tsfn = Napi::ThreadSafeFunction::New(
    env,
    info[0].As<Napi::Function>(),
    "KeyHookCallback",
    0,
    1
  );

  g_running.store(true);
  std::thread(HookThread).detach();

  return Napi::Boolean::New(env, true);
}

static Napi::Value Stop(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (!g_running.load()) {
    return Napi::Boolean::New(env, false);
  }

  g_running.store(false);

  if (g_threadId != 0) {
    PostThreadMessage(g_threadId, WM_QUIT, 0, 0);
    g_threadId = 0;
  }

  if (g_tsfn) {
    g_tsfn.Release();
  }

  return Napi::Boolean::New(env, true);
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, Stop));
  return exports;
}

NODE_API_MODULE(keyhook, Init)
