cmake_minimum_required(VERSION 3.20)
project(SaraDesktop CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
set(WV2 "${CMAKE_SOURCE_DIR}/third_party/webview2/build/native")
# The apps' version is package.json's (Settings → This computer and Settings → Apps show it).
# A copy of desktop/windows outside the repository (a scratch build) can pass -DSARA_APP_VERSION=x.y.z.
if(NOT SARA_APP_VERSION AND EXISTS "${CMAKE_SOURCE_DIR}/../../package.json")
  file(READ "${CMAKE_SOURCE_DIR}/../../package.json" SARA_PACKAGE_JSON)
  string(JSON SARA_APP_VERSION GET "${SARA_PACKAGE_JSON}" version)
endif()
if(NOT SARA_APP_VERSION)
  set(SARA_APP_VERSION "0.0.0")
endif()
string(REGEX MATCHALL "[0-9]+" SARA_VERSION_PARTS "${SARA_APP_VERSION}.0.0.0")
list(GET SARA_VERSION_PARTS 0 SARA_V1)
list(GET SARA_VERSION_PARTS 1 SARA_V2)
list(GET SARA_VERSION_PARTS 2 SARA_V3)
set(SARA_VERSION_DEFS SARA_APP_VERSION="${SARA_APP_VERSION}" SARA_VERSION_COMMAS=${SARA_V1},${SARA_V2},${SARA_V3},0)
add_executable(Sara WIN32 src/main.cpp src/hands.cpp src/hands-screen.cpp src/hands-approval.cpp src/hands-checkup.cpp src/sara.rc)
target_include_directories(Sara PRIVATE "${WV2}/include" src)
target_link_libraries(Sara PRIVATE "${WV2}/x64/WebView2LoaderStatic.lib" shlwapi shell32 ole32 version advapi32 user32 dwmapi uxtheme gdi32 windowscodecs crypt32 runtimeobject propsys winhttp ws2_32 bcrypt comdlg32 shcore oleaut32 setupapi)
# Phase 94: the read-only check-up (src/hands-checkup.cpp): SetupAPI for the battery driver's capacities; Windows Update Agent through COM (ole32/oleaut32).
# Phase 92: desktop look (src/hands-screen.cpp): GDI capture, UI Automation (ole32/oleaut32), WIC JPEG, GetDpiForMonitor (shcore).
# Phase 87: Sara's hands (src/hands.cpp): the WebSocket to /api/hands through WinHTTP.
# Phase 75 stage 3: toasts through the Windows SDK's WinRT headers (runtimeobject) and shortcut properties (propsys).
# Phase 75 stage 2: the quick-ask page (desktop/shared, also in the Mac app) is in sara.rc.
set_source_files_properties(src/sara.rc PROPERTIES OBJECT_DEPENDS "${CMAKE_SOURCE_DIR}/../shared/quick-ask.html")
set_property(SOURCE src/sara.rc APPEND PROPERTY OBJECT_DEPENDS "${CMAKE_SOURCE_DIR}/../shared/page-agent.js")
target_compile_definitions(Sara PRIVATE UNICODE _UNICODE ${SARA_VERSION_DEFS})
target_compile_options(Sara PRIVATE /W4 /permissive- /utf-8)
# Phase 68: test hooks (a separate data folder via SARA_DESKTOP_TEST_DIR), only when asked for.
option(SARA_TEST_HOOKS "Build Sara.exe with test hooks (never for release)" OFF)
if(SARA_TEST_HOOKS)
  target_compile_definitions(Sara PRIVATE SARA_TEST_HOOKS)
  add_executable(CU6Fixture WIN32 ../../test/fixtures/cu6-window.cpp)
  target_link_libraries(CU6Fixture PRIVATE user32 gdi32)
  target_compile_options(CU6Fixture PRIVATE /utf-8)
  add_executable(CU6NativeChecks ../../test/fixtures/cu6-native-checks.cpp src/hands-screen.cpp)
  target_include_directories(CU6NativeChecks PRIVATE src)
  target_compile_definitions(CU6NativeChecks PRIVATE UNICODE _UNICODE SARA_TEST_HOOKS)
  target_compile_options(CU6NativeChecks PRIVATE /W4 /permissive- /utf-8)
  target_link_libraries(CU6NativeChecks PRIVATE user32 gdi32 ole32 oleaut32 dwmapi shcore shell32 advapi32 windowscodecs)
  # Phase 94: the check-up run on this computer, printing aggregate numbers only (never a name).
  add_executable(CU7NativeChecks ../../test/fixtures/cu7-native-checks.cpp src/hands-checkup.cpp)
  target_include_directories(CU7NativeChecks PRIVATE src)
  target_compile_definitions(CU7NativeChecks PRIVATE UNICODE _UNICODE)
  target_compile_options(CU7NativeChecks PRIVATE /W4 /permissive- /utf-8)
  target_link_libraries(CU7NativeChecks PRIVATE ole32 oleaut32 shell32 advapi32 setupapi)
endif()
# Our own manifest (DPI awareness, common controls) is in sara.rc.
target_link_options(Sara PRIVATE /MANIFEST:NO)

# Phase 46c: the Windows service host for Sara's server (installed together with Sara.exe).
add_executable(SaraService WIN32 src/service.cpp src/service.rc)
target_include_directories(SaraService PRIVATE src)
target_link_libraries(SaraService PRIVATE advapi32 shell32 ws2_32 iphlpapi user32)
target_compile_definitions(SaraService PRIVATE UNICODE _UNICODE ${SARA_VERSION_DEFS})
target_compile_options(SaraService PRIVATE /W4 /permissive- /utf-8)
