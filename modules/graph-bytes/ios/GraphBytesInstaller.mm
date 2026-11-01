#import "GraphBytesInstaller.h"

#import "GraphBytes.h"

@implementation GraphBytesInstaller

+ (void)installInRuntime:(void *)runtime
{
  wtf::GraphBytes::install(*reinterpret_cast<facebook::jsi::Runtime *>(runtime));
}

@end
