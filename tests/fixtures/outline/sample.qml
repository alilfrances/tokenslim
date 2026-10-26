import QtQuick 2.15

Item {
    id: root
    width: 100

    Rectangle {
        id: box
        color: "red"
    }

    Text {
        text: "plain"
    }

    function reset() {
        box.color = "blue"
    }
}
