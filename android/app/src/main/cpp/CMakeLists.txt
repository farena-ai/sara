# C17 (docs/ops/C17_DESIGN.md): Sara's own small JNI shim over sherpa-onnx's C API. The engine
# (libsherpa-onnx-c-api.so + libonnxruntime.so) is bundled per ABI by ../../../fetch-wake-libs.sh and
# opened at run time with dlopen; only the C header is needed to compile. Without the header (a
# checkout that hasn't run the fetch script) the shim builds as a stub: Hey Sara then offers Talk only.
cmake_minimum_required(VERSION 3.22.1)
project(sarakws C)
add_library(sarakws SHARED kws.c)
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/include/sherpa-onnx/c-api/c-api.h")
  target_include_directories(sarakws PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/include")
else()
  target_compile_definitions(sarakws PRIVATE SARA_NO_KWS=1)
endif()
target_link_libraries(sarakws dl log)
