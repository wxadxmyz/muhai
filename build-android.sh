#!/bin/bash
set -e
NDK=/opt/android-sdk/ndk/26.1.10909125
export ANDROID_HOME=/opt/android-sdk
export ANDROID_SDK_ROOT=/opt/android-sdk
export ANDROID_NDK_HOME=$NDK
export NDK_HOME=$NDK
export ANDROID_NDK_ROOT=$NDK
export JAVA_HOME=/root/.sdkman/candidates/java/current
export PATH="$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/build-tools/34.0.0"

# 交叉编译器（关键）：rquickjs-sys 的 bindgen 需要目标平台 sysroot 头文件，
# 若用宿主 gcc 就会报 "'bits/libc-header-start.h' file not found"。
TC=$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin
for T in aarch64-linux-android armv7a-linux-androideabi i686-linux-android x86_64-linux-android; do
  API=21
  case $T in armv7a*) API=21;; i686*) API=21;; x86_64*) API=21;; esac
  export CC_${T//-/_}=$TC/$T$API-clang
  export CXX_${T//-/_}=$TC/$T$API-clang++
  export AR_${T//-/_}=$TC/llvm-ar
  export CARGO_TARGET_$(echo $T | tr 'a-z-' 'A-Z_')_LINKER=$TC/$T$API-clang
done
export LIBCLANG_PATH=/usr/lib/llvm-18/lib
# bindgen（rquickjs-sys 用它生成 FFI 绑定）走 libclang，而本机 clang-18 的
# "InstalledDir" 为空 → 不会自动把 multiarch 头目录 /usr/include/x86_64-linux-gnu
# 加进搜索路径，于是报 "'bits/libc-header-start.h' file not found"。
# 显式补上该路径即可（只影响 bindgen 探测，不影响实际编译用的 NDK clang）。
# bindgen 必须用「目标平台」的 sysroot（Android/bionic），否则会去找宿主 glibc 的
# gnu/stubs-32.h（Ubuntu 22.04 的 libc6-dev-i386 源里没有）。
SR=$NDK/toolchains/llvm/prebuilt/linux-x86_64/sysroot
export BINDGEN_EXTRA_CLANG_ARGS="--target=aarch64-linux-android21 -isysroot $SR -I$SR/usr/include -I$SR/usr/include/aarch64-linux-android -Wno-implicit-function-declaration"

cd /workspace/muhai
echo "=== 环境 ==="
echo "NDK: $NDK"
echo "CC aarch64: $CC_aarch64_linux_android"
echo "=== 开始构建（tauri android build --apk）==="
npx tauri android build --apk --target aarch64
