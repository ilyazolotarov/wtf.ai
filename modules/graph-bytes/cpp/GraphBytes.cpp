#include "GraphBytes.h"

#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <mutex>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <unordered_set>

namespace jsi = facebook::jsi;

namespace wtf {
namespace {

// Files open through any runtime. A handle is the descriptor, valid while it is in this set: one closed (and its
// number reused by the system for another file) can't be read through a stale handle.
std::mutex openMutex;
std::unordered_set<int> openFds;

class Bytes : public jsi::MutableBuffer {
 public:
  explicit Bytes(size_t size) : data_(size) {}
  size_t size() const override {
    return data_.size();
  }
  uint8_t *data() override {
    return data_.data();
  }
  void shrink(size_t size) {
    data_.resize(size);
  }

 private:
  std::vector<uint8_t> data_;
};

std::string failure(const char *what, const std::string &detail) {
  return std::string("graph bytes: ") + what + " " + detail + ": " + std::strerror(errno);
}

int handleOf(jsi::Runtime &rt, const jsi::Value &value) {
  if (!value.isNumber()) throw jsi::JSError(rt, "graph bytes: not a handle");
  const int fd = static_cast<int>(value.asNumber());
  std::lock_guard<std::mutex> lock(openMutex);
  if (!openFds.count(fd)) throw jsi::JSError(rt, "graph bytes: the file isn't open");
  return fd;
}

jsi::Function method(jsi::Runtime &rt, const char *name, unsigned params, jsi::HostFunctionType fn) {
  return jsi::Function::createFromHostFunction(rt, jsi::PropNameID::forAscii(rt, name), params, std::move(fn));
}

} // namespace

jsi::Value GraphBytes::get(jsi::Runtime &rt, const jsi::PropNameID &nameId) {
  // Made for the runtime that asks, each time: this object is shared with the worker runtimes.
  const std::string name = nameId.utf8(rt);
  if (name == "open") {
    return method(rt, "open", 1, [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) {
      if (count < 1 || !args[0].isString()) throw jsi::JSError(rt, "graph bytes: open(path)");
      const std::string path = args[0].asString(rt).utf8(rt);
      const int fd = ::open(path.c_str(), O_RDONLY | O_CLOEXEC);
      if (fd < 0) throw jsi::JSError(rt, failure("open", path));
      std::lock_guard<std::mutex> lock(openMutex);
      openFds.insert(fd);
      return jsi::Value(fd);
    });
  }
  if (name == "size") {
    return method(rt, "size", 1, [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) {
      if (count < 1) throw jsi::JSError(rt, "graph bytes: size(handle)");
      struct stat st;
      if (::fstat(handleOf(rt, args[0]), &st) != 0) throw jsi::JSError(rt, failure("size", ""));
      return jsi::Value(static_cast<double>(st.st_size));
    });
  }
  if (name == "read") {
    return method(rt, "read", 3, [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) {
      if (count < 3 || !args[1].isNumber() || !args[2].isNumber() || args[1].asNumber() < 0 || args[2].asNumber() < 0) {
        throw jsi::JSError(rt, "graph bytes: read(handle, offset, length)");
      }
      const int fd = handleOf(rt, args[0]);
      const auto offset = static_cast<off_t>(args[1].asNumber());
      const auto length = static_cast<size_t>(args[2].asNumber());
      auto bytes = std::make_shared<Bytes>(length);
      size_t got = 0;
      while (got < length) {
        const ssize_t n = ::pread(fd, bytes->data() + got, length - got, offset + static_cast<off_t>(got));
        if (n < 0 && errno == EINTR) continue;
        if (n < 0) throw jsi::JSError(rt, failure("read at", std::to_string(offset)));
        if (n == 0) break;
        got += static_cast<size_t>(n);
      }
      // Short at the end of the file: the caller sees the length it got.
      bytes->shrink(got);
      return jsi::Value(jsi::ArrayBuffer(rt, bytes));
    });
  }
  if (name == "close") {
    return method(rt, "close", 1, [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) {
      if (count < 1) throw jsi::JSError(rt, "graph bytes: close(handle)");
      const int fd = handleOf(rt, args[0]);
      {
        std::lock_guard<std::mutex> lock(openMutex);
        openFds.erase(fd);
      }
      ::close(fd);
      return jsi::Value::undefined();
    });
  }
  return jsi::Value::undefined();
}

std::vector<jsi::PropNameID> GraphBytes::getPropertyNames(jsi::Runtime &rt) {
  return jsi::PropNameID::names(rt, "open", "size", "read", "close");
}

void GraphBytes::install(jsi::Runtime &rt) {
  rt.global().setProperty(rt, "__wtfGraphBytes", jsi::Object::createFromHostObject(rt, std::make_shared<GraphBytes>()));
}

} // namespace wtf
