cmake_minimum_required(VERSION 3.28...3.30)

include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/common/bootstrap.cmake" NO_POLICY_SCOPE)

project(${_name} VERSION ${_version})

if(NOT WIN32)
  message(FATAL_ERROR "TheRun Races Overlay native source currently supports Windows only.")
endif()

include(compilerconfig)
include(defaults)
include(helpers)

add_library(${CMAKE_PROJECT_NAME} MODULE)

find_package(libobs REQUIRED)

target_sources(
  ${CMAKE_PROJECT_NAME}
  PRIVATE
    src/backend-manager.cpp
    src/backend-manager.hpp
    src/plugin-main.cpp
    src/race-source.cpp
    src/race-source.hpp
)

target_compile_features(${CMAKE_PROJECT_NAME} PRIVATE cxx_std_20)
target_compile_definitions(${CMAKE_PROJECT_NAME} PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN UNICODE _UNICODE)
target_link_libraries(${CMAKE_PROJECT_NAME} PRIVATE OBS::libobs gdiplus winhttp)

set_target_properties_plugin(${CMAKE_PROJECT_NAME} PROPERTIES OUTPUT_NAME ${_name})

install(FILES "${CMAKE_CURRENT_SOURCE_DIR}/LICENSE-OBS-PLUGIN" DESTINATION ${CMAKE_PROJECT_NAME})

set(BUNDLED_NODE_EXECUTABLE "" CACHE FILEPATH "Node.js executable bundled with the Windows plugin")
if(NOT BUNDLED_NODE_EXECUTABLE)
  find_program(BUNDLED_NODE_EXECUTABLE NAMES node node.exe)
endif()
if(NOT BUNDLED_NODE_EXECUTABLE OR NOT EXISTS "${BUNDLED_NODE_EXECUTABLE}")
  message(FATAL_ERROR "A Node.js executable is required to package the managed backend.")
endif()

set(NODE_LICENSE_FILE "${CMAKE_CURRENT_SOURCE_DIR}/third_party/node/LICENSE")
if(NOT EXISTS "${NODE_LICENSE_FILE}")
  message(FATAL_ERROR "The bundled Node.js license file is missing.")
endif()

install(PROGRAMS "${BUNDLED_NODE_EXECUTABLE}" DESTINATION "${CMAKE_PROJECT_NAME}/data/runtime")
install(FILES "${NODE_LICENSE_FILE}" DESTINATION "${CMAKE_PROJECT_NAME}/data/runtime")
install(FILES "${CMAKE_CURRENT_SOURCE_DIR}/server.js" DESTINATION "${CMAKE_PROJECT_NAME}/data/backend")
install(DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/public/" DESTINATION "${CMAKE_PROJECT_NAME}/data/backend/public")

add_custom_command(
  TARGET ${CMAKE_PROJECT_NAME}
  POST_BUILD
  COMMAND "${CMAKE_COMMAND}" -E make_directory
          "${CMAKE_CURRENT_BINARY_DIR}/rundir/$<CONFIG>/${CMAKE_PROJECT_NAME}/runtime"
          "${CMAKE_CURRENT_BINARY_DIR}/rundir/$<CONFIG>/${CMAKE_PROJECT_NAME}/backend/public"
  COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${BUNDLED_NODE_EXECUTABLE}"
          "${CMAKE_CURRENT_BINARY_DIR}/rundir/$<CONFIG>/${CMAKE_PROJECT_NAME}/runtime/node.exe"
  COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${NODE_LICENSE_FILE}"
          "${CMAKE_CURRENT_BINARY_DIR}/rundir/$<CONFIG>/${CMAKE_PROJECT_NAME}/runtime/LICENSE"
  COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${CMAKE_CURRENT_SOURCE_DIR}/server.js"
          "${CMAKE_CURRENT_BINARY_DIR}/rundir/$<CONFIG>/${CMAKE_PROJECT_NAME}/backend/server.js"
  COMMAND "${CMAKE_COMMAND}" -E copy_directory "${CMAKE_CURRENT_SOURCE_DIR}/public"
          "${CMAKE_CURRENT_BINARY_DIR}/rundir/$<CONFIG>/${CMAKE_PROJECT_NAME}/backend/public"
  COMMENT "Copy managed backend resources to rundir"
  VERBATIM
)
