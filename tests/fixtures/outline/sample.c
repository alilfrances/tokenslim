#include <stdio.h>
#define MAX 10

typedef struct point {
    int x;
    int y;
} point_t;

static int add(int a, int b)
{
    return a + b;
}

int main(int argc, char **argv) {
    printf("%d\n", add(1, 2));
    return 0;
}

int declared(int a);

namespace util {
void helper(int a,
            int b)
{
}
}
