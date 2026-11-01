#include <jni.h>

#include "GraphBytes.h"

// `runtime`: the `jsi::Runtime *` from the React context's JavaScriptContextHolder (JS thread).
extern "C" JNIEXPORT void JNICALL Java_ai_wtf_graphbytes_GraphBytesModule_nativeInstall(JNIEnv *, jobject, jlong runtime) {
  wtf::GraphBytes::install(*reinterpret_cast<facebook::jsi::Runtime *>(runtime));
}
