// Unit tests for the Android-free logic of the local Expo modules (modules/*/android/.../logic), the Kotlin twin of
// Package.swift. The modules themselves (LocationManager, BluetoothGatt, Expo Modules API) only compile in the Android
// build; this plain JVM project runs anywhere Gradle does: `gradle test` here (CI: Linux job, no Android SDK needed).
plugins {
  kotlin("jvm") version "2.2.0"
}

repositories {
  mavenCentral()
}

kotlin {
  jvmToolchain(17)
}

sourceSets {
  main {
    kotlin.srcDir("../modules/sensor-capture/android/src/main/java/ai/wtf/sensorcapture/logic")
  }
}

dependencies {
  testImplementation(kotlin("test"))
}

tasks.test {
  useJUnitPlatform()
  testLogging {
    events("passed", "failed", "skipped")
    showStandardStreams = false
    exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
  }
}
