cmake_minimum_required(VERSION 3.13)
project(graphbytes)

set(CMAKE_CXX_STANDARD 20)

find_package(ReactAndroid REQUIRED CONFIG)

# The reader is shared with iOS (../cpp); the JNI entry is Android's.
add_library(graphbytes SHARED ../cpp/GraphBytes.cpp src/main/cpp/GraphBytesInstall.cpp)
target_include_directories(graphbytes PRIVATE ../cpp)
target_link_libraries(graphbytes ReactAndroid::jsi android log)
